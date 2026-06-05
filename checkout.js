/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  CHECKOUT SEGURO — ULTRAKEYS                                         ║
 * ║                                                                      ║
 * ║  PRINCÍPIO: O front-end NUNCA envia preço. Ele envia apenas o        ║
 * ║  product_id. O back-end busca o preço real no banco de dados e       ║
 * ║  gera a sessão de pagamento com o valor autoritativo.                ║
 * ║                                                                      ║
 * ║  Qualquer tentativa de manipular o preço via F12/Burp Suite/etc      ║
 * ║  é automaticamente ignorada — o campo "price" do body do request     ║
 * ║  é descartado antes mesmo de chegar na lógica de negócio.            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import express from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { ProductService } from '../services/ProductService.js';
import { PaymentService } from '../services/PaymentService.js';
import { CouponService } from '../services/CouponService.js';
import { StockService } from '../services/StockService.js';

export const checkoutRoutes = express.Router();

// ── Schema de Validação (Zod) ─────────────────────────────────────────────────
// Aceita SOMENTE product_id e coupon_code — nunca preço
const CheckoutSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid('ID de produto inválido.'),
    quantity:   z.number().int().min(1).max(10),
  })).min(1).max(20),
  coupon_code: z.string().max(32).optional(),
});

/**
 * POST /api/checkout/session
 *
 * Fluxo de segurança:
 * 1. Autentica o usuário (JWT obrigatório)
 * 2. Valida o body com Zod (descarta qualquer campo extra como "price")
 * 3. Busca os preços REAIS dos produtos no banco de dados (server-side)
 * 4. Valida estoque disponível
 * 5. Aplica cupom de desconto (validação no servidor)
 * 6. Gera sessão de pagamento com o valor calculado pelo servidor
 * 7. Retorna a URL de checkout (Stripe/MercadoPago)
 */
checkoutRoutes.post('/session', requireAuth, async (req, res, next) => {
  try {
    // ── 1. Validar e sanitizar o body ─────────────────────────────────────────
    // Zod descarta automaticamente campos não declarados no schema (ex: "price")
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Dados inválidos.',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { items, coupon_code } = parsed.data;
    const userId = req.user.id; // extraído do JWT pelo middleware

    // ── 2. Buscar preços AUTORITATIVOS do banco de dados ─────────────────────
    const productIds = items.map(i => i.product_id);
    const products = await ProductService.findByIds(productIds);

    if (products.length !== productIds.length) {
      return res.status(404).json({ error: 'Um ou mais produtos não encontrados.' });
    }

    // ── 3. Verificar estoque (evita race conditions com lock pessimista) ──────
    for (const item of items) {
      const product = products.find(p => p.id === item.product_id);
      const hasStock = await StockService.checkAndReserve(product.id, item.quantity, userId);
      if (!hasStock) {
        return res.status(409).json({
          error: `Produto "${product.name}" sem estoque suficiente.`,
          product_id: product.id,
        });
      }
    }

    // ── 4. Calcular total no servidor (NUNCA confiar no front-end) ────────────
    let subtotal = 0;
    const lineItems = items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      const lineTotal = product.price_brl * item.quantity;
      subtotal += lineTotal;
      return {
        product_id: product.id,
        name:       product.name,
        unit_price: product.price_brl,
        quantity:   item.quantity,
        line_total: lineTotal,
      };
    });

    // ── 5. Aplicar cupom (validação TOTALMENTE server-side) ───────────────────
    let discountAmount = 0;
    let couponData = null;
    if (coupon_code) {
      const couponResult = await CouponService.validate(coupon_code, userId, subtotal);
      if (!couponResult.valid) {
        return res.status(400).json({ error: couponResult.reason });
      }
      discountAmount = couponResult.discount;
      couponData = couponResult;
    }

    const totalAmount = Math.max(0, subtotal - discountAmount);

    // ── 6. Criar sessão de pagamento no gateway ───────────────────────────────
    const paymentSession = await PaymentService.createSession({
      userId,
      lineItems,
      totalAmount,
      couponData,
      metadata: {
        // metadados opacos para o front-end — chaves só são entregues após confirmação webhook
        order_type: 'digital_keys',
        user_id: userId,
      },
    });

    // ── 7. Retornar URL de checkout (nunca as chaves digitais aqui!) ──────────
    return res.status(201).json({
      checkout_url:  paymentSession.url,
      session_id:    paymentSession.id,
      expires_at:    paymentSession.expires_at,
      // Exibir resumo para o usuário (valores calculados pelo servidor)
      summary: {
        subtotal:    subtotal,
        discount:    discountAmount,
        total:       totalAmount,
        currency:    'BRL',
      },
    });

  } catch (err) {
    // Liberar reservas de estoque em caso de erro
    await StockService.releaseReservations(req.user?.id).catch(() => {});
    next(err);
  }
});

/**
 * POST /api/checkout/webhook
 *
 * Webhook do gateway de pagamento (Stripe/MercadoPago).
 * SOMENTE este endpoint entrega as chaves digitais ao usuário.
 *
 * Fluxo:
 * 1. Valida a assinatura HMAC do webhook (garante que veio do gateway real)
 * 2. Confirma o pagamento no banco de dados
 * 3. Vincula as chaves digitais ao user_id
 * 4. Atualiza o estoque permanentemente
 * 5. Notifica o usuário por email
 */
checkoutRoutes.post('/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'] || req.headers['x-mp-signature'];
    if (!signature) {
      return res.status(401).json({ error: 'Assinatura do webhook ausente.' });
    }

    // Validação HMAC — rejeita webhooks falsos
    const isValid = await PaymentService.validateWebhookSignature(req.body, signature);
    if (!isValid) {
      console.warn('[SECURITY] Webhook com assinatura inválida bloqueado.');
      return res.status(401).json({ error: 'Assinatura inválida.' });
    }

    const event = JSON.parse(req.body);

    if (event.type === 'checkout.session.completed' || event.type === 'payment.approved') {
      await PaymentService.handleSuccessfulPayment(event);
      // handleSuccessfulPayment internamente:
      // → Busca o pedido pelo session_id
      // → Atribui chaves digitais aleatórias do estoque ao user_id (transação atômica)
      // → Marca estoque como vendido
      // → Envia email de entrega
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/checkout/coupon/:code
 * Preview público do cupom (sem revelar desconto exato, apenas "válido/inválido")
 */
checkoutRoutes.get('/coupon/:code', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.params;
    if (!code || code.length > 32) {
      return res.status(400).json({ error: 'Código de cupom inválido.' });
    }

    const exists = await CouponService.exists(code);
    return res.json({ valid: exists, message: exists ? 'Cupom encontrado!' : 'Cupom não encontrado.' });
  } catch (err) {
    next(err);
  }
});

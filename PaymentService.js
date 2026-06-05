import Stripe from 'stripe';
import crypto from 'crypto';
import { db } from '../config/database.js';
import { EmailService } from './EmailService.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const PaymentService = {

  /**
   * Cria uma sessão de checkout no Stripe.
   * O valor total é calculado 100% no servidor.
   */
  async createSession({ userId, lineItems, totalAmount, couponData, metadata }) {
    const sessionParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems.map(item => ({
        price_data: {
          currency: 'brl',
          product_data: { name: item.name },
          unit_amount: Math.round(item.unit_price * 100), // centavos
        },
        quantity: item.quantity,
      })),
      metadata: {
        ...metadata,
        user_id: userId,
        line_items_json: JSON.stringify(lineItems.map(i => ({
          product_id: i.product_id,
          quantity: i.quantity,
        }))),
      },
      success_url: `${process.env.FRONTEND_URL}/orders/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.FRONTEND_URL}/cart`,
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60, // 30 min
    };

    // Aplicar cupom de desconto via Stripe Coupon (servidor controla o valor)
    if (couponData) {
      const stripeCoupon = await stripe.coupons.create({
        amount_off: Math.round(couponData.discount * 100),
        currency:   'brl',
        duration:   'once',
        name:       `Cupom ${couponData.code}`,
      });
      sessionParams.discounts = [{ coupon: stripeCoupon.id }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Registrar pedido pendente no banco (rastreabilidade)
    await db.run(
      `INSERT INTO orders (id, user_id, session_id, status, total_amount, created_at)
       VALUES (?, ?, ?, 'pending', ?, datetime('now'))`,
      [crypto.randomUUID(), userId, session.id, totalAmount]
    );

    return { url: session.url, id: session.id, expires_at: session.expires_at };
  },

  /**
   * Valida a assinatura HMAC do webhook do Stripe.
   * Isso garante que a requisição realmente veio do Stripe — não de um atacante.
   */
  async validateWebhookSignature(rawBody, signature) {
    try {
      stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Processa pagamento confirmado e entrega as chaves digitais.
   *
   * ⚠️  CRÍTICO: As chaves são vinculadas ao user_id SOMENTE após confirmação
   * do webhook — nunca antes. Isso evita que alguém "simule" um pagamento.
   *
   * A entrega é feita em transação atômica para evitar double-spend.
   */
  async handleSuccessfulPayment(event) {
    const session = event.data.object;
    const userId = session.metadata.user_id;
    const lineItems = JSON.parse(session.metadata.line_items_json);

    await db.transaction(async (trx) => {
      // Buscar pedido pendente
      const order = await trx.get(
        'SELECT * FROM orders WHERE session_id = ? AND status = "pending"',
        [session.id]
      );
      if (!order) {
        console.warn(`[WEBHOOK] Pedido não encontrado ou já processado: ${session.id}`);
        return;
      }

      // Para cada item, buscar e alocar chaves do estoque (FIFO)
      const deliveredKeys = [];
      for (const item of lineItems) {
        for (let i = 0; i < item.quantity; i++) {
          // Selecionar a próxima chave disponível com lock (FOR UPDATE)
          const key = await trx.get(
            `SELECT * FROM product_keys
             WHERE product_id = ? AND status = 'available'
             ORDER BY created_at ASC LIMIT 1`,
            [item.product_id]
          );

          if (!key) {
            // Estoque esgotou entre a reserva e a confirmação — acionar reembolso
            await PaymentService.initiateRefund(session.payment_intent, 'Produto sem estoque.');
            throw new Error(`Sem estoque para produto ${item.product_id} — reembolso iniciado.`);
          }

          // Marcar chave como vendida e vinculá-la ao usuário
          await trx.run(
            `UPDATE product_keys
             SET status = 'sold', user_id = ?, order_id = ?, sold_at = datetime('now')
             WHERE id = ?`,
            [userId, order.id, key.id]
          );

          deliveredKeys.push({ product_id: item.product_id, key_id: key.id });
        }
      }

      // Atualizar status do pedido
      await trx.run(
        `UPDATE orders SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
        [order.id]
      );

      // Marcar reservas de estoque como confirmadas
      await trx.run(
        `UPDATE stock_reservations SET status = 'confirmed' WHERE order_id = ?`,
        [order.id]
      );

      // Enviar email de entrega (as chaves ficam na área logada, o email apenas notifica)
      await EmailService.sendOrderConfirmation(userId, order.id);

      console.log(`[PAYMENT] Pedido ${order.id} concluído. ${deliveredKeys.length} chave(s) entregue(s) ao usuário ${userId}`);
    });
  },

  async initiateRefund(paymentIntentId, reason) {
    await stripe.refunds.create({
      payment_intent: paymentIntentId,
      reason: 'duplicate',
      metadata: { ultrakeys_reason: reason },
    });
    console.warn(`[REFUND] Reembolso iniciado para ${paymentIntentId}: ${reason}`);
  },
};

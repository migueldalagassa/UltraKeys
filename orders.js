import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../config/database.js';

export const orderRoutes = express.Router();

/**
 * GET /api/orders
 * Histórico de pedidos do usuário autenticado
 */
orderRoutes.get('/', requireAuth, async (req, res, next) => {
  try {
    const orders = await db.all(
      `SELECT o.id, o.status, o.total_amount, o.created_at, o.completed_at,
              COUNT(pk.id) as key_count
       FROM orders o
       LEFT JOIN product_keys pk ON pk.order_id = o.id
       WHERE o.user_id = ?
       ORDER BY o.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:orderId/keys
 *
 * Revela as chaves digitais de um pedido.
 *
 * SEGURANÇA:
 * - Autenticação obrigatória (JWT)
 * - Chaves só são retornadas se o pedido pertence ao usuário autenticado
 * - Chaves só são retornadas se o status do pedido é "completed"
 * - Log de acesso registrado para auditoria
 */
orderRoutes.get('/:orderId/keys', requireAuth, async (req, res, next) => {
  try {
    const { orderId } = req.params;

    // Verificar que o pedido existe E pertence a este usuário
    const order = await db.get(
      `SELECT id, status, total_amount, completed_at
       FROM orders WHERE id = ? AND user_id = ?`,
      [orderId, req.user.id]
    );

    if (!order) {
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    if (order.status !== 'completed') {
      return res.status(402).json({
        error: 'Pagamento ainda não confirmado.',
        status: order.status,
      });
    }

    // Buscar as chaves — SOMENTE pertencentes a este pedido e usuário
    const keys = await db.all(
      `SELECT pk.id, pk.key_value, pk.product_id,
              p.name as product_name, p.platform, p.image_url
       FROM product_keys pk
       JOIN products p ON p.id = pk.product_id
       WHERE pk.order_id = ? AND pk.user_id = ?`,
      [orderId, req.user.id]
    );

    // Registrar acesso para auditoria
    await db.run(
      `INSERT INTO key_access_logs (user_id, order_id, accessed_at, ip_address)
       VALUES (?, ?, datetime('now'), ?)`,
      [req.user.id, orderId, req.ip]
    );

    res.json({
      order_id:    order.id,
      completed_at: order.completed_at,
      total_amount: order.total_amount,
      keys,
    });
  } catch (err) {
    next(err);
  }
});

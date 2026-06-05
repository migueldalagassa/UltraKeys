import jwt from 'jsonwebtoken';
import { db } from '../config/database.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 64) {
  throw new Error('JWT_SECRET deve ter no mínimo 64 caracteres. Configure no .env');
}

/**
 * Middleware de autenticação JWT.
 * Extrai e valida o token do header Authorization: Bearer <token>
 * Injeta req.user com os dados do usuário autenticado.
 */
export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
    }

    const token = authHeader.slice(7);

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer:     'ultrakeys-api',
        audience:   'ultrakeys-web',
      });
    } catch (jwtErr) {
      const message = jwtErr.name === 'TokenExpiredError'
        ? 'Sessão expirada. Faça login novamente.'
        : 'Token inválido.';
      return res.status(401).json({ error: message });
    }

    // Verificar se o token foi revogado (logout / mudança de senha)
    const isRevoked = await db.get(
      'SELECT 1 FROM revoked_tokens WHERE jti = ? AND expires_at > datetime("now")',
      [payload.jti]
    );
    if (isRevoked) {
      return res.status(401).json({ error: 'Token revogado. Faça login novamente.' });
    }

    // Buscar usuário fresco do banco (garante que conta não foi banida/desativada)
    const user = await db.get(
      'SELECT id, email, role, is_active FROM users WHERE id = ?',
      [payload.sub]
    );

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Conta inativa ou não encontrada.' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware opcional — requer papel de admin
 */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  next();
}

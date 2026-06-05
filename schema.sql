-- ═══════════════════════════════════════════════════════════════════════════
-- ULTRAKEYS — Schema do Banco de Dados
-- PostgreSQL (produção) | SQLite (desenvolvimento)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Usuários ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL, -- bcrypt, custo 12+
  display_name VARCHAR(100),
  role         VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- Tokens JWT revogados (logout, mudança de senha)
CREATE TABLE revoked_tokens (
  jti        VARCHAR(255) PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- ── Produtos ──────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(255) NOT NULL,
  slug            VARCHAR(255) UNIQUE NOT NULL,
  description     TEXT,
  platform        VARCHAR(50) NOT NULL CHECK (platform IN ('steam','epic','playstation','xbox','nintendo','google_play','apple','other')),
  type            VARCHAR(20) NOT NULL CHECK (type IN ('standard','random_key','gift_card')),
  tier            VARCHAR(20) CHECK (tier IN ('bronze','silver','gold','platinum','diamond')),
  price_brl       DECIMAL(10,2) NOT NULL, -- preço autoritativo — nunca exposto diretamente ao front
  original_price  DECIMAL(10,2),          -- para exibir desconto (UI apenas)
  image_url       TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── Estoque de Chaves Digitais ────────────────────────────────────────────────
-- Cada linha = uma chave real. Nunca exposta antes do pagamento confirmado.
CREATE TABLE product_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES products(id),
  key_value   TEXT NOT NULL,             -- a chave em si (criptografada em repouso)
  status      VARCHAR(20) DEFAULT 'available'
                CHECK (status IN ('available','reserved','sold','invalid')),
  user_id     UUID REFERENCES users(id), -- preenchido SOMENTE após pagamento confirmado
  order_id    UUID,                      -- referência ao pedido
  created_at  TIMESTAMP DEFAULT NOW(),
  sold_at     TIMESTAMP
);

CREATE INDEX idx_product_keys_status    ON product_keys(product_id, status);
CREATE INDEX idx_product_keys_user      ON product_keys(user_id);

-- ── Pedidos ───────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  session_id   VARCHAR(255) UNIQUE NOT NULL, -- ID da sessão Stripe/MercadoPago
  status       VARCHAR(20) DEFAULT 'pending'
                 CHECK (status IN ('pending','completed','refunded','failed')),
  total_amount DECIMAL(10,2) NOT NULL,       -- calculado pelo servidor
  coupon_code  VARCHAR(32),
  created_at   TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE INDEX idx_orders_user   ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_session ON orders(session_id);

-- ── Reservas de Estoque ───────────────────────────────────────────────────────
-- Reserva temporária durante o checkout (evita venda duplicada)
CREATE TABLE stock_reservations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  quantity   INT NOT NULL,
  status     VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','confirmed','released')),
  expires_at TIMESTAMP NOT NULL, -- expiração automática em 30 minutos
  created_at TIMESTAMP DEFAULT NOW()
);

-- Job agendado deve liberar reservas expiradas periodicamente
CREATE INDEX idx_reservations_expires ON stock_reservations(expires_at, status);

-- ── Cupons de Desconto ────────────────────────────────────────────────────────
CREATE TABLE coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(32) UNIQUE NOT NULL,
  type            VARCHAR(20) CHECK (type IN ('percentage','fixed_amount')),
  value           DECIMAL(10,2) NOT NULL,
  min_order_value DECIMAL(10,2) DEFAULT 0,
  max_uses        INT,
  uses_count      INT DEFAULT 0,
  valid_from      TIMESTAMP NOT NULL,
  valid_until     TIMESTAMP,
  is_active       BOOLEAN DEFAULT TRUE
);

-- Controle de uso por usuário (evita uso múltiplo)
CREATE TABLE coupon_uses (
  coupon_id  UUID REFERENCES coupons(id),
  user_id    UUID REFERENCES users(id),
  order_id   UUID REFERENCES orders(id),
  used_at    TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (coupon_id, user_id)
);

-- ── Log de Acesso às Chaves ───────────────────────────────────────────────────
-- Auditoria de quem acessou qual chave e quando
CREATE TABLE key_access_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  order_id    UUID NOT NULL REFERENCES orders(id),
  ip_address  INET,
  accessed_at TIMESTAMP DEFAULT NOW()
);

-- ── View: Estoque Disponível por Produto ─────────────────────────────────────
-- Segura para expor ao front-end (não revela key_value)
CREATE VIEW product_stock AS
SELECT
  p.id,
  p.name,
  p.platform,
  p.type,
  p.tier,
  p.price_brl,           -- exposto apenas para UI (front nunca envia de volta)
  p.original_price,
  p.image_url,
  COUNT(pk.id) FILTER (WHERE pk.status = 'available') AS stock_count,
  CASE WHEN COUNT(pk.id) FILTER (WHERE pk.status = 'available') > 0
       THEN TRUE ELSE FALSE END AS in_stock
FROM products p
LEFT JOIN product_keys pk ON pk.product_id = p.id
WHERE p.is_active = TRUE
GROUP BY p.id;

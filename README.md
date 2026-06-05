# 🔐 UltraKeys — Documentação de Arquitetura

## Stack Tecnológica

| Camada     | Tecnologia                  | Justificativa                          |
|------------|-----------------------------|----------------------------------------|
| Frontend   | HTML/CSS/JS vanilla → Next.js | Rápido de prototipar, fácil de migrar |
| Backend    | Node.js + Express           | Ecossistema rico, ideal para APIs REST |
| Banco      | PostgreSQL (prod) / SQLite  | Relacional, ACID, integridade de dados |
| Pagamento  | Stripe                      | PCI-DSS, webhook assinado com HMAC     |
| Auth       | JWT + bcrypt                | Stateless, seguro, revogável           |

---

## 🛡️ Arquitetura de Segurança Anti-Fraude

### Princípio Central: Confiança Zero no Front-end

```
CLIENTE (Browser)              SERVIDOR (Back-end)
─────────────────              ───────────────────
[ F12 / Burp Suite ]           [ Banco de Dados ]
                               
  POST /api/checkout/session         ↓
  Body: {                     SELECT price FROM products
    product_id: "uuid",  ───► WHERE id = 'uuid'
    quantity: 1               ↓
  }                     ◄─── R$ 79,90 (autoritativo)
                               ↓
  ⛔ price: 9.99 IGNORADO    Gera sessão Stripe
  ⛔ price: 0.01 IGNORADO    com valor do banco
```

### Fluxo Completo de Compra Segura

```
1. Usuário adiciona ao carrinho (front-end)
   └─ Apenas product_id é armazenado no client

2. POST /api/checkout/session
   ├─ JWT verificado (identidade do usuário)
   ├─ Zod descarta campos extras (price, etc.)
   ├─ Preço buscado no banco de dados (server-side)
   ├─ Estoque reservado com lock pessimista
   ├─ Cupom validado no servidor
   └─ Sessão Stripe criada com valor calculado

3. Usuário paga no Stripe
   └─ Stripe redireciona para /orders/success

4. Webhook POST /api/checkout/webhook (Stripe → Servidor)
   ├─ Assinatura HMAC validada (garante origem real)
   ├─ Chave digital alocada ao user_id (transação atômica)
   ├─ Estoque atualizado permanentemente
   └─ Email de notificação enviado

5. Usuário acessa GET /api/orders/:id/keys
   ├─ JWT verifica identidade
   ├─ Pedido verificado: status = 'completed' E user_id = req.user.id
   └─ Chaves reveladas APENAS ao dono do pedido
```

### Vetores de Ataque Mitigados

| Ataque                              | Mitigação                                    |
|-------------------------------------|----------------------------------------------|
| Manipulação de preço via F12        | Preço nunca lido do body da requisição       |
| Interceptação com Burp Suite        | Price hardcoded no servidor, ignorado no body|
| Cupom de uso múltiplo               | Tabela `coupon_uses` com PRIMARY KEY composta|
| Race condition no estoque           | Reserva com lock + transação atômica         |
| Webhook falso (injeção de pagamento)| Validação HMAC com secret do Stripe          |
| JWT forjado                         | Verificação de assinatura + tabela de revogados|
| Brute force de login                | Rate limiting (10 tentativas/hora)           |
| Payload gigante (DoS)               | `express.json({ limit: '10kb' })`            |
| Acesso a chaves de outros usuários  | WHERE user_id = req.user.id sempre           |
| Token roubado após logout           | Tabela `revoked_tokens` com JTI              |

---

## 📁 Estrutura de Arquivos

```
ultrakeys/
├── backend/
│   ├── src/
│   │   ├── server.js              # Entry point, middlewares globais
│   │   ├── routes/
│   │   │   ├── auth.js            # Login, registro, refresh token
│   │   │   ├── products.js        # Catálogo público (sem key_value)
│   │   │   ├── checkout.js        # ⭐ Checkout seguro (anti-fraude)
│   │   │   └── orders.js          # Histórico + revelação de chaves
│   │   ├── middleware/
│   │   │   ├── auth.js            # Verificação JWT
│   │   │   └── errorHandler.js    # Tratamento centralizado de erros
│   │   ├── services/
│   │   │   ├── PaymentService.js  # Stripe + entrega de chaves
│   │   │   ├── ProductService.js  # Queries de produtos
│   │   │   ├── CouponService.js   # Validação de cupons
│   │   │   └── StockService.js    # Reserva e controle de estoque
│   │   └── config/
│   │       ├── database.js        # Conexão com PostgreSQL
│   │       └── schema.sql         # Schema completo do banco
│   └── package.json
│
└── frontend/
    └── index.html                 # UI completa (Next.js em produção)
```

---

## ⚙️ Configuração (.env)

```env
# Banco de dados
DATABASE_URL=postgresql://user:pass@localhost:5432/ultrakeys

# JWT (mínimo 64 caracteres, gere com: openssl rand -hex 32)
JWT_SECRET=seu_jwt_secret_muito_longo_e_aleatorio_aqui

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# App
FRONTEND_URL=https://ultrakeys.com.br
PORT=3001
NODE_ENV=production
```

---

## 🚀 Como Rodar

```bash
# Backend
cd backend
npm install
npm run db:migrate
npm run dev

# Frontend (produção → Next.js)
cd frontend
npx create-next-app@latest . --yes
# copiar componentes para src/
npm run dev
```

---

## 🔒 Checklist de Segurança para Produção

- [ ] HTTPS obrigatório (HSTS habilitado)
- [ ] `NODE_ENV=production`
- [ ] JWT_SECRET com 64+ caracteres aleatórios
- [ ] Stripe Webhook Secret configurado
- [ ] Rate limiting em produção (Redis recomendado)
- [ ] Banco de dados em rede privada (não exposto à internet)
- [ ] Chaves digitais criptografadas em repouso (AES-256)
- [ ] Logs de auditoria ativos (`key_access_logs`)
- [ ] Alertas para tentativas suspeitas de checkout
- [ ] Backup automático do banco de dados

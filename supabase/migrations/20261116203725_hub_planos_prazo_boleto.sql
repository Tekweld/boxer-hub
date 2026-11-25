-- Item 2 (Andre, 2026-11-16): boleto nao e mais por "Nx parcelas" e sim por
-- plano de prazo em dias (28 / 28-56-84 / 28-56-84-112 / 30-60 / 120 direto,
-- etc.). Nao existe teto fixo hoje -- tabela livre pra qualquer admin criar/
-- editar planos no portal, sem regra de restricao por categoria de cliente
-- ainda (fica pronto pra isso no futuro, sem redesenho).
CREATE TABLE comercial.hub_planos_prazo_boleto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  dias integer[] NOT NULL,
  ordem integer NOT NULL DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comercial.hub_planos_prazo_boleto ENABLE ROW LEVEL SECURITY;

CREATE POLICY hub_planos_prazo_boleto_select ON comercial.hub_planos_prazo_boleto
  FOR SELECT TO authenticated USING (true);

CREATE POLICY hub_planos_prazo_boleto_write ON comercial.hub_planos_prazo_boleto
  FOR ALL TO authenticated
  USING (comercial.hub_user_role() = 'admin')
  WITH CHECK (comercial.hub_user_role() = 'admin');

INSERT INTO comercial.hub_planos_prazo_boleto (nome, dias, ordem) VALUES
  ('28 dias', ARRAY[28], 1),
  ('28/56/84 dias', ARRAY[28,56,84], 2),
  ('28/56/84/112 dias (cliente grande/historico)', ARRAY[28,56,84,112], 3),
  ('30/60 dias', ARRAY[30,60], 4),
  ('120 dias direto', ARRAY[120], 5);

-- Pedido grava o plano efetivamente escolhido (dias exatos de cada parcela),
-- pra push-pedido.js montar o salePayment do ZEN sem depender de
-- parcelas x 28 fixo -- e pra o financeiro ver o vencimento real de cada
-- parcela do boleto, sem precisar adivinhar.
ALTER TABLE comercial.hub_pedidos ADD COLUMN dias_pagamento integer[];

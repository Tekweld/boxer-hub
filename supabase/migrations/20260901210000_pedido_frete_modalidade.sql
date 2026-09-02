-- A politica de frete ja calcula tipo (CIF/FOB) e valor por UF, mas faltava
-- onde guardar a ESCOLHA do cliente quando ha alternativa: pagar o frete e
-- receber, ou retirar por conta propria. Regra confirmada por Andre em
-- 2026-08-31: se o pedido nao atinge o minimo para CIF gratuito, o cliente
-- pode pagar o frete OU retirar.
ALTER TABLE comercial.hub_pedidos
  ADD COLUMN IF NOT EXISTS frete_modalidade text;

ALTER TABLE comercial.hub_pedidos
  DROP CONSTRAINT IF EXISTS hub_pedidos_frete_modalidade_check;

ALTER TABLE comercial.hub_pedidos
  ADD CONSTRAINT hub_pedidos_frete_modalidade_check
  CHECK (frete_modalidade IS NULL OR frete_modalidade = ANY (ARRAY['envio'::text, 'retirada'::text]));

COMMENT ON COLUMN comercial.hub_pedidos.frete_modalidade IS
  'Escolha do cliente quando ha alternativa de frete: envio (paga o frete) ou retirada (busca por conta propria). NULL quando nao ha escolha a fazer (CIF gratuito).';

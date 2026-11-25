
-- Novo campo: o cliente indica se aceita receber pedido parcialmente
-- (com itens em falta que chegam depois) ou se prefere que a fabrica
-- espere ter tudo antes de faturar. Vai no Person.category2 do Zen.
ALTER TABLE comercial.hub_onboarding
  ADD COLUMN IF NOT EXISTS aceita_faturamento_parcial boolean DEFAULT false;

COMMENT ON COLUMN comercial.hub_onboarding.aceita_faturamento_parcial IS
  'true = aceita pedido parcial (Zen category2 "Pedido Parcial"); false = espera completo';

-- Pedido do Andre, 2026-11-06: "nao preenchemos em lugar nenhum qual classe
-- de preco foi usada" -- sem isso nao da pra auditar depois por que um
-- pedido saiu mais caro/barato que outro do mesmo cliente. Snapshot no
-- momento da revisao (nao recalcula depois -- e historico do que foi
-- efetivamente usado, mesmo que a politica do cliente mude no futuro).
alter table comercial.hub_pedidos
  add column if not exists classe_comercial_aplicada smallint,
  add column if not exists segmento_aplicado text,
  add column if not exists uf_aplicada text;

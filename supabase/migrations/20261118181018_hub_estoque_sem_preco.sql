
-- Ponto cego pedido pelo Andre: SKU com estoque real no ZEN mas sem preco
-- cadastrado na tabela Principal (public.produtos) -- hoje invisivel em
-- qualquer lugar do sistema. Populado por api/sync-estoque.js (o cubo
-- inteiro do ZEN ja e lido a cada rodada, isso e so um diff a mais, sem
-- custo de API extra).
create table if not exists comercial.hub_estoque_sem_preco (
  sku varchar primary key,
  estoque_disponivel integer not null default 0,
  atualizado_em timestamptz not null default now()
);
alter table comercial.hub_estoque_sem_preco enable row level security;
create policy hub_estoque_sem_preco_select_staff on comercial.hub_estoque_sem_preco
  for select using (comercial.hub_user_tipo() = 'funcionario' or comercial.hub_user_role() = 'admin');

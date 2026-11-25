
-- Historico de compras por cliente+produto (ultimas 5, com data/qtd/preco
-- unitario pago), pedido do Andre em 2026-11-17: aparecer AUTOMATICO ao
-- abrir a ficha do produto, sem clique. Pra nao sobrecarregar o ZEN a cada
-- clique, o desenho e: ao selecionar uma revenda (ou logar como cliente), o
-- Hub baixa de uma vez so o historico de TODOS os produtos daquele cliente
-- (1 chamada ao ZEN por cliente por dia) -- depois disso, abrir qualquer
-- produto so le esta tabela (instantaneo, sem ZEN).

create table if not exists comercial.hub_historico_compras (
  cliente_id uuid not null references comercial.hub_clientes(id),
  produto_id uuid not null references comercial.hub_produtos(id),
  sku varchar not null,
  historico jsonb not null default '[]'::jsonb, -- [{data, quantidade, preco_unitario}], mais recente primeiro, max 5
  atualizado_em timestamptz not null default now(),
  primary key (cliente_id, produto_id)
);

-- Status por cliente: quando foi a ultima vez que baixamos TUDO -- decide se
-- precisa buscar no ZEN de novo (teto de 24h) ou se já esta fresco.
create table if not exists comercial.hub_historico_compras_status (
  cliente_id uuid primary key references comercial.hub_clientes(id),
  atualizado_em timestamptz not null default now(),
  produtos_encontrados integer not null default 0
);

alter table comercial.hub_historico_compras enable row level security;
alter table comercial.hub_historico_compras_status enable row level security;

-- Mesmo padrao de RLS de hub_pedidos (dealer so o proprio, rep so a carteira,
-- staff tudo) -- quem decide quem acessa o que e a RLS, nao o endpoint.
create policy hub_historico_select_dealer on comercial.hub_historico_compras
  for select using (comercial.hub_user_tipo() = 'cliente' and cliente_id = comercial.hub_user_cliente_id());
create policy hub_historico_select_rep on comercial.hub_historico_compras
  for select using (comercial.hub_user_tipo() = 'representante' and cliente_id in (
    select hub_carteira.cliente_id from comercial.hub_carteira
    where hub_carteira.representante_id = comercial.hub_user_representante_id() and hub_carteira.ativo = true));
create policy hub_historico_select_interno on comercial.hub_historico_compras
  for select using (comercial.hub_user_role() = any (array['analyst','manager','financial','admin']));

create policy hub_historico_status_select_dealer on comercial.hub_historico_compras_status
  for select using (comercial.hub_user_tipo() = 'cliente' and cliente_id = comercial.hub_user_cliente_id());
create policy hub_historico_status_select_rep on comercial.hub_historico_compras_status
  for select using (comercial.hub_user_tipo() = 'representante' and cliente_id in (
    select hub_carteira.cliente_id from comercial.hub_carteira
    where hub_carteira.representante_id = comercial.hub_user_representante_id() and hub_carteira.ativo = true));
create policy hub_historico_status_select_interno on comercial.hub_historico_compras_status
  for select using (comercial.hub_user_role() = any (array['analyst','manager','financial','admin']));

-- Timeline do pedido para o cliente.
--
-- O status util do Zen nao e sale.status (fica PREPARED o tempo todo) e sim o
-- no ativo do workflow. hub_pedidos.erp_workflow_status ja guarda o no ATUAL,
-- mas "onde esta" nao responde "por onde passou e quando" -- que e o que o
-- cliente quer ver para nao achar que o pedido se perdeu. Dai a tabela de
-- eventos: uma linha por mudanca de etapa, append-only.

alter table comercial.hub_pedidos
  add column if not exists erp_workflow_em timestamptz;

create table if not exists comercial.hub_pedido_eventos (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references comercial.hub_pedidos(id) on delete cascade,
  etapa text not null,               -- no do workflow no Zen, ou etapa propria do Hub
  origem text not null default 'zen' check (origem in ('hub','zen')),
  detalhe text,
  criado_em timestamptz not null default now()
);

create index if not exists hub_pedido_eventos_pedido_idx
  on comercial.hub_pedido_eventos (pedido_id, criado_em);

-- Uma etapa nao se repete no mesmo pedido: o sync roda a cada 15 min e leria o
-- mesmo no varias vezes. O indice unico deixa o proprio banco descartar a
-- repeticao (ON CONFLICT DO NOTHING) em vez de o endpoint ter que comparar.
create unique index if not exists hub_pedido_eventos_unico
  on comercial.hub_pedido_eventos (pedido_id, etapa);

alter table comercial.hub_pedido_eventos enable row level security;

-- Visibilidade espelha a do pedido: quem enxerga o pedido enxerga a timeline.
create policy hub_pedido_eventos_select_dealer on comercial.hub_pedido_eventos
  for select using (
    comercial.hub_user_tipo() = 'cliente'
    and pedido_id in (select id from comercial.hub_pedidos
                       where cliente_id = comercial.hub_user_cliente_id())
  );

create policy hub_pedido_eventos_select_rep on comercial.hub_pedido_eventos
  for select using (
    comercial.hub_user_tipo() = 'representante'
    and pedido_id in (
      select p.id from comercial.hub_pedidos p
       where p.cliente_id in (select cliente_id from comercial.hub_carteira
                               where representante_id = comercial.hub_user_representante_id()
                                 and ativo = true))
  );

create policy hub_pedido_eventos_select_interno on comercial.hub_pedido_eventos
  for select using (
    comercial.hub_user_role() = any (array['analyst','manager','financial','admin'])
  );

-- Escrita so pelo conector (service_role bypassa RLS). Nenhuma policy de
-- insert/update/delete de proposito: timeline nao se edita pela tela.
comment on table comercial.hub_pedido_eventos is
  'Historico de etapas do pedido (no do workflow do Zen). Append-only, escrito pelo conector.';
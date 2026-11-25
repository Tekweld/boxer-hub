-- Rascunho de orcamento (Cristina, 2026-11-23): "salvar orcamento" pra
-- terminar depois, sem perder o trabalho -- nao toca no ZEN, nao e o
-- orcamento real (comercial.orcamentos), so guarda o estado da revisao
-- (cliente/prospect + carrinho + condicoes) ate o usuario decidir finalizar
-- pelo fluxo normal (Enviar Orcamento / Confirmar e Enviar Pedido).
create table comercial.hub_orcamento_rascunhos (
  id uuid primary key default gen_random_uuid(),
  criado_por uuid not null references auth.users(id),
  titulo text not null,
  modo text not null check (modo in ('cliente', 'prospect')),
  cliente_id uuid references comercial.hub_clientes(id),
  prospect jsonb,
  cart jsonb not null,
  detalhes jsonb,
  destinatario jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table comercial.hub_orcamento_rascunhos enable row level security;

create policy hub_orcamento_rascunhos_dono on comercial.hub_orcamento_rascunhos
  for all using (criado_por = auth.uid()) with check (criado_por = auth.uid());

grant select, insert, update, delete on comercial.hub_orcamento_rascunhos to authenticated;


create table if not exists comercial.hub_pdm_sem_preco (
  sku varchar primary key,
  nome varchar not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

alter table comercial.hub_pdm_sem_preco enable row level security;

create policy hub_pdm_sem_preco_select_staff on comercial.hub_pdm_sem_preco
  for select
  using (comercial.hub_user_tipo() = 'funcionario' or comercial.hub_user_role() = 'admin');

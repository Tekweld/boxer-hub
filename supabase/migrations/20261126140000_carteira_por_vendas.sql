-- Regra do Andre (2026-11-26): "se houve alguma venda do vendedor para o cliente, esse cliente sempre
-- aparece na lista de clientes desse vendedor" -- exceto vendas do time SAC/pos-venda (mesma lista do BAV).
--
-- Antes: hub_carteira so espelhava hub_clientes.representante_id (= Person.personSalesperson do ZEN, UM
-- vendedor por cliente). Cliente que compra com varios vendedores (Plurimaquinas: Cristina e Ceanna) ficava
-- so na carteira de um, e o outro via "Nenhuma revenda encontrada". hub_carteira ja aceita varios vendedores
-- por cliente (unique representante_id + cliente_id): faltava alimentar a partir das VENDAS.

alter table comercial.hub_carteira
  add column if not exists origem text not null default 'cadastro_zen',
  add column if not exists ultima_venda_em date;

alter table comercial.hub_carteira drop constraint if exists hub_carteira_origem_check;
alter table comercial.hub_carteira
  add constraint hub_carteira_origem_check check (origem in ('cadastro_zen', 'venda_zen', 'manual'));

comment on column comercial.hub_carteira.origem is
  'cadastro_zen = vendedor cadastrado na Person do ZEN; venda_zen = tem venda para o cliente (api/_carteira_vendas.js); manual = admin.';
comment on column comercial.hub_carteira.ultima_venda_em is 'Data da venda mais recente desse vendedor para o cliente (ZEN), quando origem/venda existe.';

-- Time SAC/pos-venda: a venda deles NAO coloca o cliente na carteira (mesma lista do BAV,
-- scripts/carimbar_entidade_vendas.py::_VENDEDORES_CANAL_HERDADO).
alter table comercial.hub_representantes add column if not exists time_sac boolean not null default false;
comment on column comercial.hub_representantes.time_sac is
  'SAC/pos-venda: vendas dele nao incluem o cliente na carteira (api/_carteira_vendas.js). Lista do BAV.';
-- A marcacao dos representantes do SAC (lista do BAV) foi feita direto no banco, sem nomes neste repo publico.

-- Registra pares (vendedor, cliente) vistos nas vendas do ZEN. Idempotente: so cria o que nao existe e
-- avanca ultima_venda_em. NAO reativa vinculo que o admin desativou (ativo=false) e ignora time SAC.
create or replace function comercial.hub_fn_carteira_registrar_vendas(p_pares jsonb)
returns jsonb
language plpgsql
security definer
set search_path = comercial, public
as $$
declare v_novos int := 0; v_existentes int := 0;
begin
  with dados as (
    select (x ->> 'representante_id')::uuid as rep, (x ->> 'cliente_id')::uuid as cli, (x ->> 'ultima_venda_em')::date as dt
    from jsonb_array_elements(p_pares) x
  ), agrupado as (
    select d.rep, d.cli, max(d.dt) as dt
    from dados d join comercial.hub_representantes r on r.id = d.rep and not r.time_sac
    group by d.rep, d.cli
  ), ins as (
    insert into comercial.hub_carteira (representante_id, cliente_id, origem, ultima_venda_em, data_vinculo)
    select rep, cli, 'venda_zen', dt, current_date from agrupado
    on conflict (representante_id, cliente_id)
    do update set ultima_venda_em = greatest(comercial.hub_carteira.ultima_venda_em, excluded.ultima_venda_em)
    returning (xmax = 0) as inserido
  )
  select count(*) filter (where inserido), count(*) filter (where not inserido) into v_novos, v_existentes from ins;
  return jsonb_build_object('novos', v_novos, 'ja_existiam', v_existentes);
end;
$$;
revoke all on function comercial.hub_fn_carteira_registrar_vendas(jsonb) from public, anon, authenticated;
grant execute on function comercial.hub_fn_carteira_registrar_vendas(jsonb) to service_role;
comment on function comercial.hub_fn_carteira_registrar_vendas(jsonb) is
  'Chamada por api/_carteira_vendas.js (service_role): inclui na carteira o vendedor que vendeu para o cliente (exceto time_sac).';

-- Carteira criada a partir de venda NAO enfileira backfill de historico: seriam milhares de clientes de
-- uma vez (so 7 representantes tem login, mas cada um tem centenas de clientes por venda).
create or replace function comercial.hub_trg_carteira_nova_enfileira_backfill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  IF NEW.ativo IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.origem = 'venda_zen' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM comercial.hub_perfis
     WHERE representante_id = NEW.representante_id AND tipo = 'representante' AND ativo = true
  ) THEN
    PERFORM comercial.hub_fn_enfileirar_backfill(NEW.cliente_id);
  END IF;
  RETURN NEW;
end;
$$;

-- Troca do vendedor cadastrado no ZEN (hub_clientes.representante_id): o novo entra na carteira e o antigo
-- sai SE o vinculo dele era so de cadastro e ele nunca vendeu para o cliente (vendeu = continua, regra do Andre).
create or replace function comercial.hub_trg_clientes_troca_representante()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if new.representante_id is distinct from old.representante_id then
    if new.representante_id is not null then
      insert into comercial.hub_carteira (representante_id, cliente_id, origem, data_vinculo)
      values (new.representante_id, new.id, 'cadastro_zen', current_date)
      on conflict (representante_id, cliente_id) do nothing;
    end if;
    if old.representante_id is not null then
      update comercial.hub_carteira
         set ativo = false
       where representante_id = old.representante_id and cliente_id = new.id
         and origem = 'cadastro_zen' and ultima_venda_em is null and ativo;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_hub_clientes_troca_representante on comercial.hub_clientes;
create trigger trg_hub_clientes_troca_representante
  after update of representante_id on comercial.hub_clientes
  for each row execute function comercial.hub_trg_clientes_troca_representante();

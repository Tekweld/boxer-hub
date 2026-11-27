-- Etapa 3 (2026-11-27): acesso por ENTIDADE. Decisao do Andre: quem tem uma loja de um grupo (ou de uma empresa com o mesmo CNPJ
-- raiz) ve E age em todas as lojas da mesma entidade (grupo do ZEN -> CNPJ raiz -> loja, regra do BAV; hub_clientes.entidade_key).
--
-- Como: o RLS de pedidos, titulos, NFs, enderecos, solicitacoes, cadastro e orcamentos ja depende de hub_carteira. Em vez de reescrever
-- cada politica, a carteira e EXPANDIDA: para cada vinculo "ancora" (origem cadastro_zen/venda_zen/manual) do representante, cria
-- vinculos origem='grupo' para as demais lojas da entidade. Grupo nao ancora outro grupo (sem cascata). Perde a ancora -> o vinculo
-- de grupo e desativado. Revenda (dealer) NAO muda: continua vendo so a propria loja. Entidade 'C:' (loja unica) nunca expande.

alter table comercial.hub_carteira drop constraint if exists hub_carteira_origem_check;
alter table comercial.hub_carteira
  add constraint hub_carteira_origem_check check (origem in ('cadastro_zen', 'venda_zen', 'manual', 'grupo'));
comment on column comercial.hub_carteira.origem is
  'cadastro_zen = vendedor da Person no ZEN; venda_zen = tem venda para o cliente; manual = admin; grupo = outra loja da mesma entidade (grupo/CNPJ raiz) de uma loja ancora.';

-- Sincroniza as lojas de grupo. p_rep / p_entidade restringem o escopo (null = tudo). Idempotente.
create or replace function comercial.hub_fn_carteira_grupo_sincronizar(p_rep uuid default null, p_entidade text default null)
returns jsonb
language plpgsql
security definer
set search_path = comercial, public
as $$
declare v_novos int := 0; v_reativados int := 0; v_desativados int := 0;
begin
  perform set_config('hub.grupo_sync', '1', true);   -- guarda de recursao: os gatilhos abaixo ignoram o que esta funcao grava
  with ancoras as (
    select distinct ca.representante_id as rep, c.entidade_key
      from comercial.hub_carteira ca
      join comercial.hub_clientes c on c.id = ca.cliente_id and c.ativo
     where ca.ativo and ca.origem <> 'grupo'
       and c.entidade_key is not null and c.entidade_key not like 'C:%'
       and (p_rep is null or ca.representante_id = p_rep)
       and (p_entidade is null or c.entidade_key = p_entidade)
  ), alvo as (
    select a.rep, c2.id as cliente_id
      from ancoras a
      join comercial.hub_clientes c2 on c2.entidade_key = a.entidade_key and c2.ativo
  ), ins as (
    insert into comercial.hub_carteira (representante_id, cliente_id, origem, data_vinculo)
    select rep, cliente_id, 'grupo', current_date from alvo
    on conflict (representante_id, cliente_id)
    do update set ativo = true where comercial.hub_carteira.origem = 'grupo' and not comercial.hub_carteira.ativo
    returning (xmax = 0) as inserido
  )
  select count(*) filter (where inserido), count(*) filter (where not inserido) into v_novos, v_reativados from ins;

  -- perdeu a ancora (ou a loja saiu da entidade): desativa o vinculo de grupo
  update comercial.hub_carteira g set ativo = false
   where g.origem = 'grupo' and g.ativo
     and (p_rep is null or g.representante_id = p_rep)
     and not exists (
       select 1 from comercial.hub_carteira x
         join comercial.hub_clientes xc on xc.id = x.cliente_id and xc.ativo
         join comercial.hub_clientes tc on tc.id = g.cliente_id
        where x.representante_id = g.representante_id and x.ativo and x.origem <> 'grupo'
          and xc.entidade_key = tc.entidade_key and tc.entidade_key not like 'C:%')
     and (p_entidade is null or exists (select 1 from comercial.hub_clientes t where t.id = g.cliente_id and t.entidade_key = p_entidade));
  get diagnostics v_desativados = row_count;
  perform set_config('hub.grupo_sync', '0', true);

  return jsonb_build_object('novos', v_novos, 'reativados', v_reativados, 'desativados', v_desativados);
end;
$$;
revoke all on function comercial.hub_fn_carteira_grupo_sincronizar(uuid, text) from public, anon, authenticated;
grant execute on function comercial.hub_fn_carteira_grupo_sincronizar(uuid, text) to service_role;

-- Carteira de grupo nao enfileira backfill de historico (como a carteira por venda).
create or replace function comercial.hub_trg_carteira_nova_enfileira_backfill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  IF NEW.ativo IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.origem IN ('venda_zen', 'grupo') THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM comercial.hub_perfis
     WHERE representante_id = NEW.representante_id AND tipo = 'representante' AND ativo = true
  ) THEN
    PERFORM comercial.hub_fn_enfileirar_backfill(NEW.cliente_id);
  END IF;
  RETURN NEW;
end;
$$;

-- Gatilhos: carteira mudou (vinculo ancora entrou/saiu) ou a loja mudou de entidade -> recalcula so o escopo afetado.
create or replace function comercial.hub_trg_carteira_grupo_apos_carteira()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if coalesce(current_setting('hub.grupo_sync', true), '0') = '1' then return new; end if;   -- evita recursao (a funcao grava em hub_carteira)
  if new.origem = 'grupo' then return new; end if;
  perform comercial.hub_fn_carteira_grupo_sincronizar(new.representante_id, null);
  return new;
end;
$$;
drop trigger if exists trg_hub_carteira_grupo on comercial.hub_carteira;
create trigger trg_hub_carteira_grupo
  after insert or update of ativo on comercial.hub_carteira
  for each row execute function comercial.hub_trg_carteira_grupo_apos_carteira();

create or replace function comercial.hub_trg_carteira_grupo_apos_cliente()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if coalesce(current_setting('hub.grupo_sync', true), '0') = '1' then return new; end if;
  perform comercial.hub_fn_carteira_grupo_sincronizar(null, new.entidade_key);
  if tg_op = 'UPDATE' and old.entidade_key is distinct from new.entidade_key and old.entidade_key is not null then
    perform comercial.hub_fn_carteira_grupo_sincronizar(null, old.entidade_key);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_hub_clientes_carteira_grupo on comercial.hub_clientes;
drop trigger if exists trg_hub_clientes_carteira_grupo_ins on comercial.hub_clientes;
drop trigger if exists trg_hub_clientes_carteira_grupo_upd on comercial.hub_clientes;
create trigger trg_hub_clientes_carteira_grupo_ins
  after insert on comercial.hub_clientes
  for each row when (new.entidade_key is not null)
  execute function comercial.hub_trg_carteira_grupo_apos_cliente();
create trigger trg_hub_clientes_carteira_grupo_upd
  after update of entidade_key on comercial.hub_clientes
  for each row when (old.entidade_key is distinct from new.entidade_key)
  execute function comercial.hub_trg_carteira_grupo_apos_cliente();

-- backfill inicial
select comercial.hub_fn_carteira_grupo_sincronizar(null, null);

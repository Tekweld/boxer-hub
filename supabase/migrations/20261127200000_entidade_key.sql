-- Entidade de cliente (regra do BAV, docs/arquitetura-base-cliente.md do bav-boxer): grupo do ZEN -> senao CNPJ raiz
-- (8 primeiros digitos = empresa/filiais) -> senao a propria loja. Resolvida UMA vez no cadastro; todo o Hub le a mesma chave.
--   'G:<grupo_erp_id>' | 'E:<cnpj raiz>' | 'C:<id>' (CPF/documento fora do padrao).
-- Etapas 1 e 2 (2026-11-27): so a chave + busca por grupo. O acesso por entidade (RLS) e outra etapa.
alter table comercial.hub_clientes add column if not exists entidade_key text;
create index if not exists ix_hub_clientes_entidade_key on comercial.hub_clientes (entidade_key);
comment on column comercial.hub_clientes.entidade_key is
  'G:<grupo_erp_id> (rede do ZEN) | E:<cnpj raiz> (empresa/filiais) | C:<id> (loja unica). Mantida por gatilho.';

create or replace function comercial.hub_fn_entidade_key(p_id uuid, p_cnpj text, p_grupo int)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_grupo is not null then 'G:' || p_grupo::text
    when length(regexp_replace(coalesce(p_cnpj, ''), '\D', '', 'g')) = 14 then 'E:' || left(regexp_replace(p_cnpj, '\D', '', 'g'), 8)
    else 'C:' || p_id::text
  end;
$$;

create or replace function comercial.hub_trg_entidade_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.entidade_key := comercial.hub_fn_entidade_key(new.id, new.cnpj, new.grupo_erp_id);
  return new;
end;
$$;
drop trigger if exists trg_hub_clientes_entidade_key on comercial.hub_clientes;
create trigger trg_hub_clientes_entidade_key
  before insert or update of grupo_erp_id, cnpj on comercial.hub_clientes
  for each row execute function comercial.hub_trg_entidade_key();

-- backfill
update comercial.hub_clientes set entidade_key = comercial.hub_fn_entidade_key(id, cnpj, grupo_erp_id)
 where entidade_key is distinct from comercial.hub_fn_entidade_key(id, cnpj, grupo_erp_id);

-- Resumo por entidade para a busca ("Grupo X, N lojas"). Conta TODAS as lojas ativas (a RLS limitaria a contagem a carteira
-- do usuario); devolve so chave, nome e quantidade -- nenhum dado de loja.
create or replace function comercial.hub_fn_entidade_resumo(p_keys text[])
returns table (entidade_key text, nome text, lojas bigint, raizes bigint)
language sql
stable
security definer
set search_path = comercial, public
as $$
  select c.entidade_key,
         coalesce(max(c.grupo_nome), (array_agg(coalesce(c.nome_exibicao, c.razao_social) order by c.cnpj))[1]) as nome,
         count(*) as lojas,
         count(distinct left(regexp_replace(c.cnpj, '\D', '', 'g'), 8)) as raizes
    from comercial.hub_clientes c
   where c.ativo and c.entidade_key = any (p_keys)
   group by c.entidade_key;
$$;
revoke all on function comercial.hub_fn_entidade_resumo(text[]) from public, anon;
grant execute on function comercial.hub_fn_entidade_resumo(text[]) to authenticated, service_role;

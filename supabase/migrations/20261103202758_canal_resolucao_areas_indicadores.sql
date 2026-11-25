
-- hub_perfis: area do time interno (financeiro/vendas_adm/cadastro/ti/comercial) -- usada p/ rotear hub_solicitacoes
alter table comercial.hub_perfis add column if not exists area text;

-- hub_solicitacoes: area responsavel, quem assumiu, quando, quando resolveu
alter table comercial.hub_solicitacoes
  add column if not exists area_responsavel varchar default 'vendas_adm',
  add column if not exists assumido_por uuid,
  add column if not exists assumido_por_nome varchar,
  add column if not exists assumido_em timestamptz,
  add column if not exists resolvido_em timestamptz;

-- backfill existentes por categoria
update comercial.hub_solicitacoes
   set area_responsavel = case when categoria = 'financeiro' then 'financeiro' else 'vendas_adm' end
 where area_responsavel is null or area_responsavel = 'vendas_adm';

-- backfill resolvido_em para as ja resolvidas (aproxima pelo atualizado_em)
update comercial.hub_solicitacoes
   set resolvido_em = atualizado_em
 where status = 'resolvida' and resolvido_em is null;

-- trigger de preenchimento: agora tambem resolve area_responsavel por categoria
create or replace function comercial.hub_trg_solicitacao_preencher()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if NEW.numero is null then
    NEW.numero := comercial.hub_fn_gerar_numero_solicitacao();
  end if;

  if NEW.representante_id is null then
    select representante_id into NEW.representante_id
      from comercial.hub_carteira
     where cliente_id = NEW.cliente_id and ativo = true
     limit 1;
  end if;

  if NEW.area_responsavel is null then
    NEW.area_responsavel := case when NEW.categoria = 'financeiro' then 'financeiro' else 'vendas_adm' end;
  end if;

  return NEW;
end;
$function$;

-- trigger: marca/limpa resolvido_em conforme status muda (p/ medir horas em aberto)
create or replace function comercial.hub_trg_solicitacao_resolvido_em()
 returns trigger
 language plpgsql
as $function$
begin
  if NEW.status = 'resolvida' and (OLD.status is distinct from 'resolvida') then
    NEW.resolvido_em := now();
  elsif NEW.status <> 'resolvida' and OLD.status = 'resolvida' then
    NEW.resolvido_em := null;
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_hub_solicitacao_resolvido_em on comercial.hub_solicitacoes;
create trigger trg_hub_solicitacao_resolvido_em
  before update on comercial.hub_solicitacoes
  for each row execute function comercial.hub_trg_solicitacao_resolvido_em();

-- view de indicadores: contagem e horas medias/max em aberto, por area e por quem assumiu
create or replace view comercial.hub_v_solicitacoes_indicadores as
select
  area_responsavel,
  assumido_por,
  assumido_por_nome,
  status,
  count(*) as total,
  round((avg(extract(epoch from (coalesce(resolvido_em, now()) - criado_em)) / 3600))::numeric, 1) as horas_medias,
  round((max(extract(epoch from (coalesce(resolvido_em, now()) - criado_em)) / 3600))::numeric, 1) as horas_max
from comercial.hub_solicitacoes
where ativo = true
group by area_responsavel, assumido_por, assumido_por_nome, status;

grant select on comercial.hub_v_solicitacoes_indicadores to anon, authenticated;

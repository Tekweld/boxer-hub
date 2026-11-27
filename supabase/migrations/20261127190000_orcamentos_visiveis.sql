-- Visibilidade de orcamentos (2026-11-27): equipe Boxer/admin veem todos (decidido no backend por papel); representante ve os
-- proprios + os de clientes da CARTEIRA dele (hub_carteira, que agora inclui quem vendeu); revenda nao ve orcamento.
-- Funcoes so para o service_role (api/_orcamento.js chama com a chave de servico, ja depois de autenticar o usuario).

-- ids visiveis ao representante (mais recentes primeiro)
create or replace function comercial.hub_fn_orcamentos_visiveis_ids(p_user uuid, p_limite int default 150)
returns setof uuid
language sql
stable
security definer
set search_path = comercial, public
as $$
  select o.id
    from comercial.orcamentos o
   where o.ativo
     and (o.user_id = p_user
          or o.cliente_cnpj in (
               select regexp_replace(c.cnpj, '\D', '', 'g')
                 from comercial.hub_perfis p
                 join comercial.hub_carteira ca on ca.representante_id = p.representante_id and ca.ativo
                 join comercial.hub_clientes c on c.id = ca.cliente_id
                where p.user_id = p_user and p.ativo and p.representante_id is not null))
   order by o.criado_em desc
   limit greatest(1, least(p_limite, 400));
$$;

create or replace function comercial.hub_fn_orcamento_visivel(p_user uuid, p_orcamento uuid)
returns boolean
language sql
stable
security definer
set search_path = comercial, public
as $$
  select exists (
    select 1 from comercial.orcamentos o
     where o.id = p_orcamento
       and (o.user_id = p_user
            or o.cliente_cnpj in (
                 select regexp_replace(c.cnpj, '\D', '', 'g')
                   from comercial.hub_perfis p
                   join comercial.hub_carteira ca on ca.representante_id = p.representante_id and ca.ativo
                   join comercial.hub_clientes c on c.id = ca.cliente_id
                  where p.user_id = p_user and p.ativo and p.representante_id is not null)));
$$;

revoke all on function comercial.hub_fn_orcamentos_visiveis_ids(uuid, int) from public, anon, authenticated;
revoke all on function comercial.hub_fn_orcamento_visivel(uuid, uuid) from public, anon, authenticated;
grant execute on function comercial.hub_fn_orcamentos_visiveis_ids(uuid, int) to service_role;
grant execute on function comercial.hub_fn_orcamento_visivel(uuid, uuid) to service_role;

-- Analista (funcionario Boxer) passa a usar o orcamento como um representante, com a visao de todos (2026-11-27).
-- public.tabela_acesso() e compartilhada com a tabela de precos: so a lista de papeis aceitos de hub_perfis muda.
CREATE OR REPLACE FUNCTION public.tabela_acesso()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text; v_sid uuid; v_criada timestamptz; v_otp boolean;
  v_u record; v_cp record; v_pf record; v_hub boolean; v_hp record;
  v_dias constant int := 15;
begin
  if v_uid is null then return jsonb_build_object('permitido', false, 'motivo', 'sem_login'); end if;
  select email into v_email from auth.users where id = v_uid;
 v_hub := public.tabela_usa_hub(v_email);

  select * into v_hp from comercial.hub_perfis where user_id = v_uid and ativo limit 1;
  if found and (v_hp.tipo = 'representante' or v_hp.role in ('admin','manager','analyst')) then
    return jsonb_build_object('permitido', true, 'teste', not v_hub, 'nome', coalesce(v_hp.nome, v_email), 'origem', 'hub_perfis', 'role', coalesce(v_hp.role, v_hp.tipo));
  end if;

  begin v_sid := (auth.jwt() ->> 'session_id')::uuid; exception when others then v_sid := null; end;
  if v_sid is null then return jsonb_build_object('permitido', false, 'motivo', 'sem_codigo'); end if;
  select coalesce(refreshed_at at time zone 'utc', created_at) into v_criada from auth.sessions where id = v_sid;
  select exists (select 1 from auth.mfa_amr_claims where session_id = v_sid and authentication_method in ('otp','magiclink')) into v_otp;
  if not coalesce(v_otp, false) then return jsonb_build_object('permitido', false, 'motivo', 'sem_codigo'); end if;
  if v_criada is null or v_criada < now() - make_interval(days => v_dias) then
    return jsonb_build_object('permitido', false, 'motivo', 'sessao_expirada');
  end if;
  if exists (select 1 from public.tabela_usuarios u where lower(u.email) = lower(v_email) and not u.ativo) then
    return jsonb_build_object('permitido', false, 'motivo', 'inativo');
  end if;
  select * into v_u from public.tabela_usuarios where lower(email) = lower(v_email) and ativo and (validade is null or validade >= current_date) limit 1;
  if found then
    return jsonb_build_object('permitido', true, 'teste', not v_hub, 'nome', coalesce(v_u.nome, v_email), 'origem', 'tabela_usuarios', 'role', coalesce(v_u.perfil, v_u.tipo), 'telefone', v_u.telefone, 'empresa', v_u.empresa, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  select * into v_cp from comercial.comercial_perfis where user_id = v_uid limit 1;
  if found then
    return jsonb_build_object('permitido', true, 'teste', not v_hub, 'nome', coalesce(v_cp.nome, v_email), 'origem', 'comercial_perfis', 'role', v_cp.role, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  select * into v_pf from public.perfis where id = v_uid limit 1;
  if found then
    return jsonb_build_object('permitido', true, 'teste', not v_hub, 'nome', coalesce(v_pf.nome, v_email), 'origem', 'perfis', 'role', v_pf.permissao::text, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  return jsonb_build_object('permitido', false, 'motivo', 'nao_liberado');
end;
$function$;

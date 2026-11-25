CREATE OR REPLACE FUNCTION comercial.hub_fn_precos_parametro(
  p_uf       text,
  p_segmento text,
  p_classe   smallint
)
RETURNS TABLE (
  produto_id    uuid,
  sku           text,
  preco_tabela  numeric,
  preco_final   numeric,
  multiplicador numeric,
  porte         text,
  icms          numeric,
  ipi           numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  WITH base AS (
    SELECT hp.id AS produto_id,
           hp.sku::text AS sku,
           pp.pv_sp,
           pp.porte::text AS porte,
           pp.icms,
           pp.ipi,
           vc.categoria_grupo,
           est.mult_4_icms,
           est.mult_total
      FROM comercial.hub_produtos hp
      JOIN public.produtos pp
        ON upper(btrim(pp.codigo)) = upper(btrim(hp.sku))
       AND pp.tabela_id = 1
       AND pp.ativo = true
       AND pp.pv_sp > 0
      LEFT JOIN comercial.hub_v_catalogo vc ON vc.produto_id = hp.id
      CROSS JOIN LATERAL (
        SELECT e.mult_4_icms, e.mult_total
          FROM public.estados e
         WHERE e.uf = p_uf
         LIMIT 1
      ) est
     WHERE hp.ativo = true
  )
  SELECT b.produto_id,
         b.sku,
         round(b.pv_sp * b.mult_4_icms / (1 - b.mult_total / 100), 2)           AS preco_tabela,
         round(b.pv_sp * b.mult_4_icms / (1 - b.mult_total / 100) * m.valor, 2) AS preco_final,
         m.valor,
         b.porte,
         b.icms,
         b.ipi
    FROM base b
    CROSS JOIN LATERAL (
      SELECT mm.valor
        FROM public.multiplicadores mm
       WHERE mm.tabela_id = 1
         AND mm.segmento  = p_segmento
         AND mm.classe    = p_classe
         AND mm.porte     = b.porte
         AND (mm.categoria_grupo IS NULL OR mm.categoria_grupo = b.categoria_grupo)
       ORDER BY mm.categoria_grupo NULLS LAST
       LIMIT 1
    ) m;
$$;

COMMENT ON FUNCTION comercial.hub_fn_precos_parametro(text, text, smallint) IS
  'Precos do catalogo para um cenario de politica comercial explicito (uf/segmento/classe), sem depender de um cliente cadastrado. Uso: representante/staff simulando orcamento.';

GRANT EXECUTE ON FUNCTION comercial.hub_fn_precos_parametro(text, text, smallint) TO authenticated;

CREATE OR REPLACE FUNCTION public.tabela_acesso()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text; v_sid uuid; v_criada timestamptz; v_otp boolean;
  v_u record; v_cp record; v_pf record; v_hp record;
  v_dias constant int := 15;
begin
  if v_uid is null then return jsonb_build_object('permitido', false, 'motivo', 'sem_login'); end if;
  select email into v_email from auth.users where id = v_uid;

  select * into v_hp from comercial.hub_perfis where user_id = v_uid and ativo limit 1;
  if found and (v_hp.tipo = 'representante' or v_hp.role in ('admin','manager')) then
    return jsonb_build_object('permitido', true, 'nome', coalesce(v_hp.nome, v_email), 'origem', 'hub_perfis', 'role', coalesce(v_hp.role, v_hp.tipo));
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
    return jsonb_build_object('permitido', true, 'nome', coalesce(v_u.nome, v_email), 'origem', 'tabela_usuarios', 'role', coalesce(v_u.perfil, v_u.tipo), 'telefone', v_u.telefone, 'empresa', v_u.empresa, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  select * into v_cp from comercial.comercial_perfis where user_id = v_uid limit 1;
  if found then
    return jsonb_build_object('permitido', true, 'nome', coalesce(v_cp.nome, v_email), 'origem', 'comercial_perfis', 'role', v_cp.role, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  select * into v_pf from public.perfis where id = v_uid limit 1;
  if found then
    return jsonb_build_object('permitido', true, 'nome', coalesce(v_pf.nome, v_email), 'origem', 'perfis', 'role', v_pf.permissao::text, 'sessao_expira_em', v_criada + make_interval(days => v_dias));
  end if;
  return jsonb_build_object('permitido', false, 'motivo', 'nao_liberado');
end;
$function$;
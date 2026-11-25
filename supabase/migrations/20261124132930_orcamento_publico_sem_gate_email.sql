CREATE OR REPLACE FUNCTION comercial.buscar_orcamento_publico_v2(p_token uuid, p_sessao text, p_ua text DEFAULT NULL::text, p_contar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o comercial.orcamentos%rowtype; v_exp boolean; v_email text;
begin
  -- 2026-11-24, pedido explicito do Andre: o gate de email+codigo (lerSessao/
  -- telaEmail no orcamento-publico.html) travava o cliente real no primeiro
  -- clique do link -- "o cliente tem que receber link, clicar e ja acessar".
  -- Sem p_sessao (frontend passa null agora), autoriza direto pela posse do
  -- token, so registrando "link_direto" como visualizador -- sem quebrar quem
  -- ainda tiver uma sessao de email valida de antes (fallback abaixo).
  if p_sessao is not null and p_sessao <> '' then
    v_email := public.link_sessao_email('orcamento', p_token::text, p_sessao);
    if v_email is null then return jsonb_build_object('encontrado', false, 'sessao', false); end if;
  else
    v_email := 'link_direto';
  end if;
  select * into o from comercial.orcamentos where token = p_token and ativo;
  if not found then return jsonb_build_object('encontrado', false); end if;
  v_exp := o.validade_em < now() and o.status in ('enviado','visualizado');
  if o.status <> 'cancelado' and p_contar then
    update comercial.orcamentos set
      visualizacoes = visualizacoes + 1,
      primeira_visualizacao_em = coalesce(primeira_visualizacao_em, now()),
      ultima_visualizacao_em = now(),
      status = case when status = 'enviado' and not v_exp then 'visualizado' else status end,
      atualizado_em = now()
    where id = o.id;
    perform public.link_registrar('orcamento', p_token::text, o.id, o.codigo, v_email, 'visualizou', p_ua);
  end if;
  return jsonb_build_object(
    'encontrado', true, 'visualizador', v_email,
    'codigo', o.codigo, 'criado_em', o.criado_em, 'validade_em', o.validade_em,
    'expirado', v_exp, 'status', o.status,
    'vendedor_nome', o.vendedor_nome, 'vendedor_email', o.vendedor_email, 'vendedor_telefone', o.vendedor_telefone,
    'vendedor_empresa', o.vendedor_empresa,
    'cliente_nome', o.cliente_nome, 'cliente_fantasia', o.cliente_fantasia, 'cliente_cnpj', o.cliente_cnpj,
    'cliente_contato', o.cliente_contato, 'cliente_cidade', o.cliente_cidade, 'cliente_uf', o.cliente_uf,
    'cliente_endereco', o.cliente_endereco,
    'uf', o.uf, 'pagamento_tipo', o.pagamento_tipo, 'parcelas', o.parcelas, 'desconto_vista_pct', o.desconto_vista_pct,
    'frete_tipo', o.frete_tipo, 'frete_valor', o.frete_valor, 'observacoes', o.observacoes,
    'itens', o.itens, 'total_itens', o.total_itens, 'total_final', o.total_final,
    'aceito_em', o.aceito_em);
end $function$;

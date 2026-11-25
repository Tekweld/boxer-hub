
CREATE OR REPLACE FUNCTION comercial.hub_fn_submeter_onboarding(
  p_cnpj text,
  p_razao_social text,
  p_nome_fantasia text,
  p_inscricao_estadual text,
  p_contato_nome text,
  p_contato_email text,
  p_contato_telefone text,
  p_enderecos jsonb,
  p_contatos jsonb,
  p_respostas_classificacao jsonb,
  p_classificacao text DEFAULT NULL,
  p_representante_nome text DEFAULT NULL,
  p_regiao text DEFAULT NULL,
  p_documentos jsonb DEFAULT '[]'::jsonb,
  p_aceita_faturamento_parcial boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_existe boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM comercial.hub_onboarding
    WHERE cnpj = p_cnpj AND ativo = true AND etapa_atual NOT IN ('rejeitado')) INTO v_existe;
  IF v_existe THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Ja existe um cadastro em andamento para este CNPJ.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM comercial.hub_clientes
    WHERE cnpj = p_cnpj AND ativo = true) INTO v_existe;
  IF v_existe THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este CNPJ ja esta cadastrado como cliente ativo. Use a opcao "Esqueci minha senha" na tela de login.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM auth.users WHERE email = p_contato_email) INTO v_existe;
  IF v_existe THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Este email ja possui uma conta no sistema. Use a opcao "Esqueci minha senha" na tela de login.');
  END IF;

  INSERT INTO comercial.hub_onboarding (
    cnpj, razao_social, nome_fantasia, inscricao_estadual,
    contato_nome, contato_email, contato_telefone,
    enderecos, contatos, respostas_classificacao,
    classificacao, regiao,
    documentos_base64,
    aceita_faturamento_parcial,
    etapa_atual, criado_por_tipo
  ) VALUES (
    p_cnpj, p_razao_social, p_nome_fantasia, p_inscricao_estadual,
    p_contato_nome, p_contato_email, p_contato_telefone,
    p_enderecos, p_contatos, p_respostas_classificacao,
    p_classificacao, p_regiao,
    p_documentos,
    COALESCE(p_aceita_faturamento_parcial, false),
    'validacao_ia', 'cliente'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

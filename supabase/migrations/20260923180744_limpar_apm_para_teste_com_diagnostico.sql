
DELETE FROM comercial.hub_perfis WHERE user_id = '378d9b17-c18c-4d6a-9d13-32d5075f2518';
DELETE FROM comercial.hub_clientes WHERE cnpj = '49623549000121';
DELETE FROM auth.users WHERE email = 'usuario-teste@example.invalid';

UPDATE comercial.hub_onboarding
SET etapa_atual = 'ativacao', cliente_id = NULL, user_id = NULL, erp_cliente_id = NULL,
    atualizado_em = now()
WHERE cnpj = '49623549000121';

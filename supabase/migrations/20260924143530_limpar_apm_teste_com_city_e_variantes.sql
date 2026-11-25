
DELETE FROM comercial.hub_perfis WHERE user_id = 'abed5b80-40c3-4f94-8754-4febd1b0caf5';
DELETE FROM comercial.hub_clientes WHERE cnpj = '49623549000121';
DELETE FROM auth.users WHERE email = 'usuario-teste@example.invalid';
UPDATE comercial.hub_onboarding
SET etapa_atual='ativacao', cliente_id=NULL, user_id=NULL, erp_cliente_id=NULL, atualizado_em=now()
WHERE cnpj='49623549000121';

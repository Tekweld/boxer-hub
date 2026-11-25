
DELETE FROM comercial.hub_perfis WHERE user_id = 'b7e66ead-ee60-4820-9a96-9453397049eb';
DELETE FROM comercial.hub_clientes WHERE cnpj = '49623549000121';
DELETE FROM auth.users WHERE email = 'usuario-teste@example.invalid';
UPDATE comercial.hub_onboarding
SET etapa_atual='ativacao', cliente_id=NULL, user_id=NULL, erp_cliente_id=NULL, atualizado_em=now()
WHERE cnpj='49623549000121';

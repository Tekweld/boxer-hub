
DELETE FROM comercial.hub_perfis WHERE user_id='da3d867b-a763-4ca4-9385-bd69ba3fd0f3';
DELETE FROM comercial.hub_clientes WHERE cnpj='49623549000121';
DELETE FROM auth.users WHERE email='usuario-teste@example.invalid';
UPDATE comercial.hub_onboarding SET etapa_atual='ativacao', cliente_id=NULL, user_id=NULL, erp_cliente_id=NULL, atualizado_em=now() WHERE cnpj='49623549000121';

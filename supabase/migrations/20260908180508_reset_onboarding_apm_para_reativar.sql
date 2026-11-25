-- APM DA EE Prof. ficou em ativacao sem completar (falha ZEN por
-- nationality.id=1). Com o bug corrigido, quero acionar novamente. Mantem
-- limite_aprovado e classificacao; so garante que esta em 'ativacao'.
update comercial.hub_onboarding
   set etapa_atual = 'ativacao', atualizado_em = now()
 where id = '44c5cb74-b5e3-448a-a45f-31664693f452';
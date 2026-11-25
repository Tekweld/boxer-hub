update comercial.hub_planos_prazo_boleto set nome = '28/56/84/112 dias' where dias = array[28,56,84,112];

insert into comercial.hub_planos_prazo_boleto (nome, dias, ordem, ativo) values
  ('15/30 dias', array[15,30], 10, true),
  ('15/30/45 dias', array[15,30,45], 11, true),
  ('15/30/45/60 dias', array[15,30,45,60], 12, true),
  ('15/30/45/60/75 dias', array[15,30,45,60,75], 13, true),
  ('15/30/45/60/75/90 dias', array[15,30,45,60,75,90], 14, true),
  ('60 dias direto', array[60], 20, true),
  ('75 dias direto', array[75], 21, true),
  ('90 dias direto', array[90], 22, true),
  ('60/120 dias', array[60,120], 23, true),
  ('60/120/180/240 dias', array[60,120,180,240], 24, true);

update comercial.hub_planos_prazo_boleto set ordem = 30 where nome = '120 dias direto';

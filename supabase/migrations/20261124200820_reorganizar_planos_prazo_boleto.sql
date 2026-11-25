-- Reorganiza hub_planos_prazo_boleto em blocos (28/30/15 dias parcelados,
-- diretos, e novo bloco 60 dias de 30 em 30 ate 3x), pedido do Andre 24/11.
-- Sem FK apontando pra esta tabela (confirmado antes de aplicar) -- seguro
-- substituir tudo de uma vez; pedidos/orcamentos antigos guardam o array de
-- dias escolhido em dias_pagamento, nao o id do plano, entao nao quebram.

delete from comercial.hub_planos_prazo_boleto;

insert into comercial.hub_planos_prazo_boleto (nome, dias, ordem) values
  -- Bloco 28 dias
  ('28 dias', array[28], 1),
  ('28/56 dias', array[28,56], 2),
  ('28/56/84 dias', array[28,56,84], 3),
  ('28/56/84/112 dias', array[28,56,84,112], 4),
  ('28/56/84/112/140 dias', array[28,56,84,112,140], 5),
  ('28/56/84/112/140/168 dias', array[28,56,84,112,140,168], 6),

  -- Bloco 30 dias
  ('30 dias', array[30], 10),
  ('30/60 dias', array[30,60], 11),
  ('30/60/90 dias', array[30,60,90], 12),
  ('30/60/90/120 dias', array[30,60,90,120], 13),
  ('30/60/90/120/150 dias', array[30,60,90,120,150], 14),
  ('30/60/90/120/150/180 dias', array[30,60,90,120,150,180], 15),

  -- Bloco 15 dias
  ('15 dias', array[15], 20),
  ('15/30 dias', array[15,30], 21),
  ('15/30/45 dias', array[15,30,45], 22),
  ('15/30/45/60 dias', array[15,30,45,60], 23),
  ('15/30/45/60/75 dias', array[15,30,45,60,75], 24),
  ('15/30/45/60/75/90 dias', array[15,30,45,60,75,90], 25),

  -- Bloco diretos (parcela unica). 28 e 30 dias ficam de fora pra nao
  -- duplicar o 1x dos blocos acima (mesmo array = mesma condicao).
  ('7 dias direto', array[7], 30),
  ('14 dias direto', array[14], 31),
  ('21 dias direto', array[21], 32),
  ('45 dias direto', array[45], 33),
  ('60 dias direto', array[60], 34),
  ('75 dias direto', array[75], 35),
  ('90 dias direto', array[90], 36),
  ('120 dias direto', array[120], 37),
  ('150 dias direto', array[150], 38),

  -- Bloco 60 dias, de 30 em 30, ate 3x. "60 dias" sozinho ja existe no
  -- bloco diretos acima, entao este bloco comeca em 2x.
  ('60/90 dias', array[60,90], 40),
  ('60/90/120 dias', array[60,90,120], 41);

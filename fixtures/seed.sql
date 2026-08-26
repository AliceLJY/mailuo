INSERT INTO contacts (
  id,
  canonical_name,
  aliases,
  company,
  title,
  phone,
  wechat_id,
  tags,
  notes,
  created_at,
  updated_at
) VALUES
  (
    1,
    '陈昕',
    '["陈老师","云沐陈昕"]',
    '云沐内容',
    '内容合作负责人',
    '13900003157',
    'chenxin_ym',
    '["播客","品牌合作"]',
    'fictional seed contact for screenshot-3 update scenario',
    '2026-07-02T09:10:00+08:00',
    '2026-07-28T18:40:00+08:00'
  ),
  (
    2,
    '林然',
    '["栖川林然","L. Ran"]',
    '栖川数据',
    '商务经理',
    '13800007654',
    'linran_qcd',
    '["潜在线索"]',
    'fictional seed contact for later ambiguity checks',
    '2026-06-18T11:20:00+08:00',
    '2026-08-10T16:05:00+08:00'
  );

INSERT INTO observations (
  id,
  contact_id,
  screenshot_id,
  kind,
  content,
  source_quote,
  observed_at
) VALUES
  (
    1,
    1,
    NULL,
    'interaction',
    '陈昕曾以云沐内容身份对接播客联名合作。',
    NULL,
    '2026-07-28T18:40:00+08:00'
  );

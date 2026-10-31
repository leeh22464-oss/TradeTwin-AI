import type {
  CaseRecord,
  CostItem,
  EvidencePage,
  EvidenceReport,
  KnowledgeEntry,
  ProductConfig,
  RuleDefinition,
} from '../shared/types';

export const RULE_VERSION = 'rules-2026.10.31-demo.v1';

export const BASE_CONFIG: ProductConfig = {
  model: 'NL-L',
  powerW: 24,
  ip: 'IP20',
  driver: 'DRV-A',
  material: 'original-material',
  market: 'DE',
};

const page = (pageNumber: number, text: string): EvidencePage => ({ page: pageNumber, text });

export const seedReports: EvidenceReport[] = [
  {
    id: 'TR-001',
    title: '安规与环境测试报告 TR-001（示意）',
    kind: 'safety',
    source: 'synthetic',
    status: 'ready',
    filename: 'TR-001-safety-demo.md',
    pageCount: 3,
    pages: [
      page(1, '样品：NL-L 系列；驱动电源 DRV-A；目标市场 EU/DE。'),
      page(2, '电气强度与绝缘项目：适用于 NL-L、DRV-A、18W–40W、IP20/IP44。'),
      page(3, '温升功率范围：18W–30W。防护等级：IP20。已完成温升、耐热、电气强度与防尘防水相关观察。'),
    ],
    coverage: {
      series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: ['IP20'], drivers: ['DRV-A'],
      materials: ['original-material'], markets: ['EU', 'DE'],
      tests: ['temperature', 'electrical-strength', 'ip'], confidence: 0.98,
    },
    testScopes: {
      temperature: {
        coverage: { series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: [], drivers: ['DRV-A'], materials: ['original-material'], markets: ['EU', 'DE'], tests: ['temperature'], confidence: 0.98 },
        page: 3, quote: '温升功率范围：18W–30W。',
      },
      ip: {
        coverage: { series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: ['IP20'], drivers: ['DRV-A'], materials: ['original-material'], markets: ['EU', 'DE'], tests: ['ip'], confidence: 0.98 },
        page: 3, quote: '防护等级：IP20。',
      },
      'electrical-strength': {
        coverage: { series: 'NL-L', powerMinW: 18, powerMaxW: 40, ipLevels: ['IP20', 'IP44'], drivers: ['DRV-A'], materials: ['original-material'], markets: ['EU', 'DE'], tests: ['electrical-strength'], confidence: 0.95 },
        page: 2, quote: '电气强度与绝缘项目：适用于 NL-L、DRV-A、18W–40W、IP20/IP44。',
      },
    },
    verified: true,
    notes: '合成示意数据；实际适用范围以检测机构确认的报告原文为准。',
    createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'TR-002',
    title: 'EMC 测试报告 TR-002（示意）',
    kind: 'emc',
    source: 'synthetic',
    status: 'ready',
    filename: 'TR-002-emc-demo.md',
    pageCount: 2,
    pages: [
      page(1, 'EMC 适用系列：NL-L；驱动电源 DRV-A；材料 original-material；功率 18W–40W。'),
      page(2, 'EMC 测试已完成；IP 等级不作为本报告的独立判定条件。'),
    ],
    coverage: {
      series: 'NL-L', powerMinW: 18, powerMaxW: 40, ipLevels: [], drivers: ['DRV-A'],
      materials: ['original-material'], markets: ['EU', 'DE'], tests: ['emc'], confidence: 0.96,
    },
    testScopes: {
      emc: {
        coverage: { series: 'NL-L', powerMinW: 18, powerMaxW: 40, ipLevels: [], drivers: ['DRV-A'], materials: ['original-material'], markets: ['EU', 'DE'], tests: ['emc'], confidence: 0.96 },
        page: 1, quote: 'EMC 适用系列：NL-L；驱动电源 DRV-A；材料 original-material；功率 18W–40W。',
      },
    },
    verified: true,
    notes: 'EMC 有独立覆盖条件；驱动相同只是必要条件之一。',
    createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'TR-003',
    title: 'RoHS 材料声明 TR-003（示意）',
    kind: 'rohs',
    source: 'synthetic',
    status: 'ready',
    filename: 'TR-003-rohs-demo.md',
    pageCount: 1,
    pages: [page(1, '材料组合：original-material；NL-L 外壳与 PCB；RoHS 证据已归档。')],
    coverage: {
      series: 'NL-L', powerMinW: null, powerMaxW: null, ipLevels: [], drivers: [],
      materials: ['original-material'], markets: ['EU', 'DE'], tests: ['rohs'], confidence: 0.97,
    },
    testScopes: {
      rohs: {
        coverage: { series: 'NL-L', powerMinW: null, powerMaxW: null, ipLevels: [], drivers: [], materials: ['original-material'], markets: ['EU', 'DE'], tests: ['rohs'], confidence: 0.97 },
        page: 1, quote: '材料组合：original-material；NL-L 外壳与 PCB；RoHS 证据已归档。',
      },
    },
    verified: true,
    notes: '材料变更需要重新核对供应商声明与 RoHS/REACH 证据。',
    createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'SPEC-001',
    title: '产品规格书 NL-L（示意）', kind: 'spec', source: 'synthetic', status: 'ready',
    filename: 'NL-L-spec-demo.md', pageCount: 2,
    pages: [page(1, '规格基线：24W、IP20、DRV-A。'), page(2, '产品系列：NL-L；目标市场：德国。')],
    coverage: {
      series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: ['IP20'], drivers: ['DRV-A'],
      materials: ['original-material'], markets: ['EU', 'DE'], tests: ['spec'], confidence: 0.94,
    },
    verified: true, notes: '用于演示文档变更回写。', createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'DOC-001', title: 'EU DoC（示意）', kind: 'doc', source: 'synthetic', status: 'ready',
    filename: 'NL-L-doc-demo.md', pageCount: 1,
    pages: [page(1, 'DoC：NL-L、24W、IP20、DRV-A；示意声明。')],
    coverage: {
      series: 'NL-L', powerMinW: 24, powerMaxW: 24, ipLevels: ['IP20'], drivers: ['DRV-A'],
      materials: ['original-material'], markets: ['EU', 'DE'], tests: ['doc'], confidence: 0.9,
    },
    verified: true, notes: '配置变化时需要重新生成或复核。', createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'LABEL-001', title: '产品标签与包装（示意）', kind: 'label', source: 'synthetic', status: 'ready',
    filename: 'NL-L-label-demo.txt', pageCount: 1,
    pages: [page(1, '标签：功率 24W；IP20；型号 NL-L。')],
    coverage: {
      series: 'NL-L', powerMinW: 24, powerMaxW: 24, ipLevels: ['IP20'], drivers: [],
      materials: [], markets: ['EU', 'DE'], tests: ['label'], confidence: 0.9,
    },
    verified: true, notes: '标签必须与最终报价配置一致。', createdAt: '2026-10-31T00:00:00.000Z',
  },
  {
    id: 'MANUAL-001', title: '德语安装说明书（示意）', kind: 'manual', source: 'synthetic', status: 'ready',
    filename: 'NL-L-manual-de-demo.md', pageCount: 2,
    pages: [page(1, '德语安装说明书：NL-L、IP20。'), page(2, '说明书中的电气参数与安装环境应随配置复核。')],
    coverage: {
      series: 'NL-L', powerMinW: 18, powerMaxW: 30, ipLevels: ['IP20'], drivers: ['DRV-A'],
      materials: [], markets: ['DE'], tests: ['manual'], confidence: 0.9,
    },
    verified: true, notes: '手册更新为内部文档工作，不等同于检测结论。', createdAt: '2026-10-31T00:00:00.000Z',
  },
];

export const seedCosts: CostItem[] = [
  { id: 'temperature', title: '温升与耐热相关测试', feeEur: 1200, days: 6, group: 'test' },
  { id: 'ip', title: '防尘防水测试', feeEur: 900, days: 5, group: 'test' },
  { id: 'emc', title: 'EMC 测试', feeEur: 1500, days: 7, group: 'test' },
  { id: 'electrical-strength', title: '电气强度与绝缘复核', feeEur: 0, days: 3, group: 'test' },
  { id: 'rohs', title: 'RoHS / REACH 材料证据复核', feeEur: 0, days: 3, group: 'test' },
  { id: 'document-update', title: 'DoC、标签、规格书与德语说明书更新', feeEur: 0, days: 2, group: 'document' },
];

const rule = (id: string, title: string, description: string, category: string): RuleDefinition => ({
  id, title, description, category, version: RULE_VERSION,
});

export const seedRules: RuleDefinition[] = [
  rule('R-SERIES-001', '型号系列一致', '报告系列必须覆盖当前型号系列。', 'coverage'),
  rule('R-POWER-001', '功率范围覆盖', '逐个测试项目核对功率区间，超出区间不能沿用。', 'coverage'),
  rule('R-IP-001', '防护等级变化', 'IP 等级变化需要核对并补做对应防尘防水测试。', 'coverage'),
  rule('R-DRIVER-001', '驱动电源变化', '驱动更换影响 EMC 与电气安全复核。', 'mapping'),
  rule('R-MATERIAL-001', '材料变化', '材料变化影响 RoHS/REACH 证据与供应商声明。', 'mapping'),
  rule('R-MARKET-001', '目标市场覆盖', '报告或声明必须有目标市场适用范围。', 'coverage'),
  rule('R-TEMP-001', '温升测试映射', '功率超出温升报告区间时生成温升补测。', 'mapping'),
  rule('R-IP-002', '防尘防水测试映射', '防护等级变化且报告未覆盖新等级时生成 IP 补测。', 'mapping'),
  rule('R-EMC-001', 'EMC 独立条件', 'EMC 可沿用需要驱动、功率、系列、材料和市场等条件共同匹配。', 'mapping'),
  rule('R-ROHS-001', 'RoHS 材料证据', '材料与报告不一致时生成 RoHS/REACH 复核。', 'mapping'),
  rule('R-DOC-001', 'DoC 更新', '功率、IP、驱动、材料或市场变化后更新 DoC。', 'documents'),
  rule('R-LABEL-001', '标签更新', '功率或 IP 变化后更新产品标签。', 'documents'),
  rule('R-MANUAL-001', '说明书更新', '功率、IP、驱动、市场或安装条件变化后更新说明书。', 'documents'),
  rule('R-CONTRACT-001', '交期承诺风险', '补测或排期未确认时不承诺原交期。', 'contract'),
  rule('R-REVIEW-001', '证据不足升级', '缺失、未验证或范围不明时进入人工核验。', 'safety'),
];

export const seedKnowledge: KnowledgeEntry[] = [
  {
    id: 'kb-coverage-model', title: '证据覆盖范围推理说明', source: 'knowledge/evidence-coverage.md',
    tags: ['覆盖范围', '证据', '示意数据'], updatedAt: '2026-10-31',
    content: '系统判断现有报告能否覆盖新配置。报告范围、条件、项目和页码均为合成演示数据，实际以检测机构意见为准。',
  },
  {
    id: 'kb-germany-business', title: '德国客户报价口径', source: 'knowledge/germany-quote-guidance.md',
    tags: ['德国', '英语', '德语', '报价'], updatedAt: '2026-10-31',
    content: '对外回复需要说明补测项目、排期与最终价格确认条件；内部岗位分别接收销售、品质和采购待办。',
  },
  {
    id: 'kb-eu-regulatory-index', title: '欧盟法规来源索引', source: 'knowledge/eu-regulatory-index.md',
    tags: ['欧盟', 'LVD', 'EMC', 'RoHS', '官方来源', '人工核验'], updatedAt: '2026-10-31',
    content: '本条目仅用于定位公开法规原文，不等于 NL-L 灯具的适用性、测试充分性或合规结论。功率参数不足以决定法规适用性；额定电压、结构、用途、标准版本和机构意见仍需专业核实。官方来源：2014/35/EU（LVD）https://eur-lex.europa.eu/eli/dir/2014/35/oj；2014/30/EU（EMC）https://eur-lex.europa.eu/eli/dir/2014/30/oj；2011/65/EU（RoHS）https://eur-lex.europa.eu/eli/dir/2011/65/oj。演示参数映射、费用和排期是合成数据，不是法规自动推导。',
  },
];

export function createSeedCase(): CaseRecord {
  const now = '2026-10-31T00:00:00.000Z';
  return {
    id: 'case-demo-led-de', name: '德国客户 · NL-L 灯具变更', buyer: 'Demo GmbH', createdAt: now, updatedAt: now,
    round: 1, baseConfig: { ...BASE_CONFIG }, requestedConfig: { ...BASE_CONFIG, powerW: 36, ip: 'IP44' },
    quantity: 500, unitPriceEur: 18.5, channel: 'email',
    inquiry: 'Buyer requests 36W and IP44 for the NL-L indoor fixed LED luminaire.',
    commitment: '', analysis: null, quote: null, messages: [],
  };
}

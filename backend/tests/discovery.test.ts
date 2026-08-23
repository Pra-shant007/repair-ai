/**
 * Device-discovery test suite — image-first detection + scenario resolution.
 *
 * Same conventions as phase2.test.ts: no test framework (the repo has none and
 * dependencies cannot be installed here), compiled with the backend sources and
 * run with plain `node`. Exits non-zero on any failure.
 *
 * Determinism: no real network and no randomness.
 *   - The resolver is pure, so its tests build DetectionResult objects by hand.
 *   - The controller tests force AI_PROVIDER=mock and, where a real device
 *     identification is needed, temporarily replace mockProvider.analyzeFrame
 *     with a fixed stub (restored in finally). The mock DB is forced on so the
 *     persist path never touches a real MongoDB.
 */

import assert from 'assert';

import { demoScenarios } from '../src/data/demoScenarios';
import { DetectedComponent, DetectionResult, NormalizedBox } from '../src/types/ai';
import {
  resolveScenario,
  SCENARIO_RULES,
  MIN_DEVICE_CONFIDENCE,
  MIN_MATCH_CONFIDENCE
} from '../src/services/scenarioResolver';
import { detectComponents } from '../src/controllers/aiController';
import { mockProvider } from '../src/services/ai/mockProvider';
import { resetProvider } from '../src/services/aiService';
import { connectDB } from '../src/config/db';

let passed = 0;
let failed = 0;
const failures: string[] = [];

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push(name);
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err instanceof Error ? err.message : String(err)}`);
    });
};

// ---------- builders ----------

const box: NormalizedBox = { x: 0.4, y: 0.35, width: 0.3, height: 0.1 };

/** Build a DetectedComponent with a valid normalized box. */
const comp = (name: string, confidence = 0.9): DetectedComponent => ({
  name,
  confidence,
  boundingBox: box
});

/** Build a DetectionResult directly, bypassing any provider. */
const det = (over: Partial<DetectionResult>): DetectionResult => ({
  device: null,
  components: [],
  source: 'test',
  warnings: [],
  ...over
});

/** Minimal Express response double that records status + body. */
const makeRes = () => {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
  return res;
};

/** A large, valid base64 JPEG data URL — passes parseImagePayload. */
const IMAGE = 'data:image/jpeg;base64,' + 'A'.repeat(2000);

/**
 * Run `fn` with mockProvider.analyzeFrame replaced by a fixed raw stub, so the
 * controller's image path sees a deterministic "model" result with no network.
 */
const withStubbedDetection = async (raw: unknown, fn: () => Promise<void>) => {
  const prevProvider = process.env.AI_PROVIDER;
  const prevKey = process.env.GEMINI_API_KEY;
  const original = mockProvider.analyzeFrame;

  process.env.AI_PROVIDER = 'mock';
  delete process.env.GEMINI_API_KEY;
  (mockProvider as any).analyzeFrame = async () => raw;
  resetProvider();

  try {
    await fn();
  } finally {
    (mockProvider as any).analyzeFrame = original;
    if (prevProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
    resetProvider();
  }
};

async function main() {
  // Force the in-memory DB so persistScenarioDiagnostic never dials a real
  // MongoDB. Deleting the URI first guarantees the mock branch (no 5s connect).
  delete process.env.MONGODB_URI;
  await connectDB();

  console.log('\n--- scenarioResolver: the five supported mappings ---\n');

  await test('1. laptop + RAM slot -> laptop_ram_upgrade', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Laptop', brand: 'HP', model: 'Pavilion 15', confidence: 0.95 },
        components: [comp('RAM Slot A'), comp('Battery Connection')]
      })
    );
    assert.strictEqual(match.scenarioId, 'laptop_ram_upgrade');
    assert.ok(match.confidence >= MIN_MATCH_CONFIDENCE, `confidence ${match.confidence}`);
  });

  await test('2. Dell desktop + M.2/NVMe -> ssd_installation', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Desktop PC', brand: 'Dell', model: 'Inspiron', confidence: 0.92 },
        components: [comp('M.2 NVMe Slot'), comp('CPU Cooler')]
      })
    );
    assert.strictEqual(match.scenarioId, 'ssd_installation');
    assert.ok(match.confidence >= MIN_MATCH_CONFIDENCE, `confidence ${match.confidence}`);
  });

  await test('3. MacBook Air + battery/logic board -> laptop_not_booting (beats RAM upgrade)', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Air', confidence: 0.9 },
        components: [comp('Logic Board'), comp('Battery Pack')]
      })
    );
    // Both laptop rules gate on device type 'laptop'; brand + decisive
    // component ('logic board') must break the tie toward not-booting.
    assert.strictEqual(match.scenarioId, 'laptop_not_booting');
  });

  await test('4. Samsung Galaxy S21 + USB-C board -> broken_charging_port', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Smartphone', brand: 'Samsung', model: 'Galaxy S21', confidence: 0.93 },
        components: [comp('USB-C Charging Board'), comp('Main Flex Cable Ribbon')]
      })
    );
    assert.strictEqual(match.scenarioId, 'broken_charging_port');
  });

  await test('5. Linksys AC1900 + antenna/WiFi -> wifi_adapter_issue', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Router', brand: 'Linksys', model: 'AC1900', confidence: 0.9 },
        components: [comp('Antenna Feeder Leads'), comp('WiFi Transceiver Chipset')]
      })
    );
    assert.strictEqual(match.scenarioId, 'wifi_adapter_issue');
  });

  console.log('\n--- scenarioResolver: declines ---\n');

  await test('6. unknown device type -> null (device-type gate blocks every rule)', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Toaster', brand: 'Breville', confidence: 0.9 },
        components: [comp('Heating Element')]
      })
    );
    assert.strictEqual(match.scenarioId, null);
    assert.ok(/does not match any supported repair scenario/i.test(match.reason), match.reason);
  });

  await test('7. low device confidence -> null even with a perfect keyword match', () => {
    const match = resolveScenario(
      det({
        device: { type: 'Laptop', brand: 'HP', model: 'Pavilion 15', confidence: 0.3 },
        components: [comp('RAM Slot A')]
      })
    );
    assert.strictEqual(match.scenarioId, null);
    assert.ok(match.confidence < MIN_DEVICE_CONFIDENCE);
    assert.ok(/below the/i.test(match.reason), match.reason);
  });

  await test('8. missing model but strong device+component evidence -> STILL matches', () => {
    // No model string (unreadable). Device type + brand + a decisive RAM
    // component are enough: model is supporting evidence, not required.
    const match = resolveScenario(
      det({
        device: { type: 'Laptop', brand: 'HP', confidence: 0.9 }, // model omitted
        components: [comp('RAM Slot A'), comp('RAM Slot B')]
      })
    );
    assert.strictEqual(match.scenarioId, 'laptop_ram_upgrade');
    assert.ok(match.confidence >= MIN_MATCH_CONFIDENCE, `confidence ${match.confidence}`);
  });

  console.log('\n--- scenarioResolver: guard-rails ---\n');

  await test('8b. bare device type, no brand/model/components -> null (device type alone is too weak)', () => {
    const match = resolveScenario(det({ device: { type: 'Laptop', confidence: 0.9 } }));
    // 0.4 device-type weight * 0.9 confidence = 0.36 < 0.5 match floor.
    assert.strictEqual(match.scenarioId, null);
  });

  await test('8c. null device -> null (components alone never select a procedure)', () => {
    const match = resolveScenario(det({ device: null, components: [comp('RAM Slot A')] }));
    assert.strictEqual(match.scenarioId, null);
    assert.ok(/no device/i.test(match.reason), match.reason);
  });

  await test('8d. low-confidence components are ignored as evidence', () => {
    // A bare laptop plus only a very-low-confidence RAM slot should not clear
    // the bar: the weak component is dropped, leaving device type alone.
    const match = resolveScenario(
      det({
        device: { type: 'Laptop', confidence: 0.9 },
        components: [comp('RAM Slot A', 0.2)]
      })
    );
    assert.strictEqual(match.scenarioId, null);
  });

  await test('8e. every rule points at a real demoScenarios key', () => {
    for (const rule of SCENARIO_RULES) {
      assert.ok(demoScenarios[rule.scenarioId], `missing scenario ${rule.scenarioId}`);
    }
  });

  console.log('\n--- POST /api/ai/detect: image-first + backward compatibility ---\n');

  await test('image detection WITHOUT scenarioId -> resolves scenario + steps from demoScenarios', async () => {
    await withStubbedDetection(
      {
        device: { type: 'Laptop', brand: 'HP', model: 'Pavilion 15', confidence: 0.95 },
        components: [{ name: 'RAM Slot A', confidence: 0.98, boundingBox: box }]
      },
      async () => {
        const req: any = { body: { image: IMAGE }, user: undefined };
        const res = makeRes();
        await detectComponents(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.aiPowered, true);
        assert.ok(res.body.scenario, 'scenario should be present');
        assert.strictEqual(res.body.scenario.id, 'laptop_ram_upgrade');
        // Steps MUST come verbatim from demoScenarios — never model-authored.
        assert.deepStrictEqual(res.body.steps, demoScenarios.laptop_ram_upgrade.steps);
        // Device fields reflect what the model saw.
        assert.strictEqual(res.body.device.brand, 'HP');
        assert.strictEqual(res.body.deviceType, 'Laptop');
        assert.strictEqual(res.body.detectedComponents.length, 1);
        assert.ok(res.body.diagnosticId, 'a diagnostic should be persisted for a resolved scenario');
      }
    );
  });

  await test('image detection WITHOUT scenarioId, unsupported device -> scenario:null, steps:[]', async () => {
    await withStubbedDetection(
      { device: { type: 'Toaster', brand: 'Breville', confidence: 0.9 }, components: [] },
      async () => {
        const req: any = { body: { image: IMAGE }, user: undefined };
        const res = makeRes();
        await detectComponents(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.aiPowered, true);
        assert.strictEqual(res.body.scenario, null);
        assert.deepStrictEqual(res.body.steps, []);
        assert.strictEqual(res.body.diagnosticId, null);
        assert.strictEqual(res.body.device.type, 'Toaster');
        assert.ok(/no supported repair scenario/i.test(res.body.message), res.body.message);
      }
    );
  });

  await test('existing scenarioId detection (no image) -> unchanged payload + steps + echoed scenario', async () => {
    const req: any = { body: { scenarioId: 'ssd_installation' }, user: undefined };
    const res = makeRes();
    await detectComponents(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.aiPowered, false);
    assert.strictEqual(res.body.source, 'scenario');
    assert.deepStrictEqual(res.body.steps, demoScenarios.ssd_installation.steps);
    assert.strictEqual(res.body.deviceName, demoScenarios.ssd_installation.deviceName);
    // Additive uniform field: the explicitly-supplied scenario is echoed back.
    assert.ok(res.body.scenario);
    assert.strictEqual(res.body.scenario.id, 'ssd_installation');
  });

  await test('existing guard unchanged: no image and no scenarioId -> 400', async () => {
    const req: any = { body: {}, user: undefined };
    const res = makeRes();
    await detectComponents(req, res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('malformed AI device result (no type) -> device dropped, scenario:null, steps:[]', async () => {
    await withStubbedDetection(
      // No `type`: normalizeDevice drops the whole identification and warns.
      { device: { brand: 'Mystery', confidence: 0.9 }, components: [] },
      async () => {
        const req: any = { body: { image: IMAGE }, user: undefined };
        const res = makeRes();
        await detectComponents(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.device, null);
        assert.strictEqual(res.body.scenario, null);
        assert.deepStrictEqual(res.body.steps, []);
        assert.ok(
          res.body.warnings.some((w: string) => /device/i.test(w)),
          'a warning should explain the dropped device'
        );
        assert.ok(/no device could be identified/i.test(res.body.message), res.body.message);
      }
    );
  });

  await test('image + KNOWN scenarioId -> scenario steps + AI detections (path 2a, unchanged)', async () => {
    await withStubbedDetection(
      {
        device: { type: 'Laptop', brand: 'HP', model: 'Pavilion 15', confidence: 0.9 },
        components: [{ name: 'RAM Slot A', confidence: 0.9, boundingBox: box }]
      },
      async () => {
        const req: any = { body: { image: IMAGE, scenarioId: 'laptop_ram_upgrade' }, user: undefined };
        const res = makeRes();
        await detectComponents(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.aiPowered, true);
        assert.deepStrictEqual(res.body.steps, demoScenarios.laptop_ram_upgrade.steps);
        assert.strictEqual(res.body.scenario.id, 'laptop_ram_upgrade');
        assert.strictEqual(res.body.detectedComponents.length, 1);
      }
    );
  });

  console.log(`\n================  ${passed} passed, ${failed} failed  ================`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});

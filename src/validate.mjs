import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemaPath = (name) => fileURLToPath(new URL(`../schemas/${name}`, import.meta.url));
const load = (name) => JSON.parse(readFileSync(schemaPath(name), 'utf8'));

export const manifestSchema = load('manifest.schema.json'); // contract pin: test-only export, asserted by the suite
const workOrderSchema = load('work-order.schema.json');
const eventsSchema = load('events.schema.json');
export const jobStates = load('job-states.json');
const decisionFileSchema = load('decision-file.schema.json');

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(workOrderSchema);
ajv.addSchema(eventsSchema);
ajv.addSchema(decisionFileSchema);
ajv.addSchema(manifestSchema);

const bind = (id) => {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema not registered: ${id}`);
  return (data) => {
    const ok = validate(data);
    return { ok, errors: ok ? [] : validate.errors };
  };
};

export const validateManifest = bind(manifestSchema.$id);
export const validateWorkOrder = bind(workOrderSchema.$id);
export const validateEvent = bind(eventsSchema.$id);
export const validateDecisionFile = bind(decisionFileSchema.$id);

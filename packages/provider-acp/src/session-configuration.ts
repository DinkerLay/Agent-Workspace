import { createHash } from "node:crypto";
import type { InjectedAcpV1Connection } from "./connection.js";
import { failAcp } from "./errors.js";
import { asRecord } from "./qualification.js";
import type {
  AcpModelCatalogEntry,
  AcpSessionConfigIntent,
  AcpSessionConfigurationIntent,
} from "./types.js";

interface ParsedConfigOption {
  readonly id: string;
  readonly category?: string;
  readonly type: "select" | "boolean";
  readonly currentValue: string | boolean;
  readonly selectableValues: readonly AcpModelCatalogEntry[];
}

export async function configureAcpV1Session(input: {
  readonly connection: InjectedAcpV1Connection;
  readonly rawSessionId: string;
  readonly bindingResponse: unknown;
  readonly intent: AcpSessionConfigurationIntent;
}): Promise<{
  readonly model: string;
  readonly modelCatalog: readonly AcpModelCatalogEntry[];
  readonly configurationFingerprint: string;
}> {
  validateIntent(input.intent);
  const response = asRecord(input.bindingResponse, "acp_binding_response_invalid");
  let options = parseConfigOptions(response.configOptions);

  const modelOption = resolveModelOption(options, input.intent.model);
  const prevalidatedOptions = input.intent.options.map((intent) => (
    resolveExplicitOption(options, intent)
  ));
  if (prevalidatedOptions.some((option) => option.id === modelOption.id)) {
    failAcp("acp_session_config_intent_conflict");
  }
  const legacyMode = input.intent.legacyModeId
    ? resolveLegacyMode(response.modes, input.intent.legacyModeId)
    : undefined;

  options = await applyConfigValue({
    connection: input.connection,
    rawSessionId: input.rawSessionId,
    currentOptions: options,
    option: modelOption,
    value: input.intent.model,
  });

  for (const configIntent of input.intent.options) {
    const option = resolveExplicitOption(options, configIntent);
    options = await applyConfigValue({
      connection: input.connection,
      rawSessionId: input.rawSessionId,
      currentOptions: options,
      option,
      value: configIntent.value,
    });
  }

  if (input.intent.legacyModeId && legacyMode) {
    if (legacyMode.currentModeId !== input.intent.legacyModeId) {
      if (!input.connection.setSessionMode) failAcp("acp_set_session_mode_unavailable");
      try {
        await input.connection.setSessionMode({
          sessionId: input.rawSessionId,
          modeId: input.intent.legacyModeId,
        });
      } catch {
        failAcp("acp_set_session_mode_failed");
      }
    }
  }

  const finalModelOption = resolveModelOption(options, input.intent.model);
  return {
    model: input.intent.model,
    modelCatalog: Object.freeze(finalModelOption.selectableValues.map((entry) => Object.freeze({ ...entry }))),
    configurationFingerprint: `sha256:${createHash("sha256")
      .update(stableJson(input.intent))
      .digest("hex")}`,
  };
}

export function inspectAcpV1SessionModelCatalog(bindingResponse: unknown): Readonly<{
  readonly currentModel: string;
  readonly modelCatalog: readonly AcpModelCatalogEntry[];
}> {
  const response = asRecord(bindingResponse, "acp_binding_response_invalid");
  const options = parseConfigOptions(response.configOptions);
  const modelOptions = options.filter((option) => (
    option.category === "model" && option.type === "select"
  ));
  if (modelOptions.length === 0) failAcp("acp_model_option_missing");
  if (modelOptions.length !== 1) failAcp("acp_model_option_ambiguous");
  const modelOption = modelOptions[0]!;
  if (modelOption.selectableValues.filter(({ modelId }) => (
    modelId === modelOption.currentValue
  )).length !== 1) {
    failAcp("acp_model_current_value_invalid");
  }
  return Object.freeze({
    currentModel: modelOption.currentValue as string,
    modelCatalog: Object.freeze(modelOption.selectableValues.map((entry) => Object.freeze({ ...entry }))),
  });
}

function resolveLegacyMode(value: unknown, legacyModeId: string): {
  readonly currentModeId: unknown;
} {
  const modes = asRecord(value, "acp_legacy_modes_missing");
  if (!Array.isArray(modes.availableModes)) failAcp("acp_legacy_modes_invalid");
  const exactModes = modes.availableModes.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).id === legacyModeId
  ));
  if (exactModes.length === 0) failAcp("acp_legacy_mode_missing");
  if (exactModes.length !== 1) failAcp("acp_legacy_mode_ambiguous");
  return { currentModeId: modes.currentModeId };
}

async function applyConfigValue(input: {
  readonly connection: InjectedAcpV1Connection;
  readonly rawSessionId: string;
  readonly currentOptions: readonly ParsedConfigOption[];
  readonly option: ParsedConfigOption;
  readonly value: string | boolean;
}): Promise<readonly ParsedConfigOption[]> {
  if (input.option.currentValue === input.value) return input.currentOptions;
  if (!input.connection.setSessionConfigOption) {
    failAcp("acp_set_session_config_option_unavailable");
  }
  let response: unknown;
  try {
    response = await input.connection.setSessionConfigOption({
      sessionId: input.rawSessionId,
      configId: input.option.id,
      value: input.value,
      ...(input.option.type === "boolean" ? { type: "boolean" } : {}),
    });
  } catch {
    failAcp("acp_set_session_config_option_failed");
  }
  const responseRecord = asRecord(response, "acp_session_config_response_invalid");
  const nextOptions = parseConfigOptions(responseRecord.configOptions);
  const confirmation = nextOptions.filter((candidate) => candidate.id === input.option.id);
  if (
    confirmation.length !== 1
    || confirmation[0].type !== input.option.type
    || confirmation[0].category !== input.option.category
    || confirmation[0].currentValue !== input.value
    || (confirmation[0].type === "select"
      && confirmation[0].selectableValues.filter(({ modelId }) => modelId === input.value).length !== 1)
  ) {
    failAcp("acp_session_config_confirmation_invalid");
  }
  return nextOptions;
}

function resolveModelOption(
  options: readonly ParsedConfigOption[],
  model: string,
): ParsedConfigOption {
  const matches = options.filter((option) => (
    option.category === "model"
    && option.type === "select"
    && option.selectableValues.some(({ modelId }) => modelId === model)
  ));
  if (matches.length === 0) failAcp("acp_model_option_missing");
  if (matches.length !== 1) failAcp("acp_model_option_ambiguous");
  if (matches[0].selectableValues.filter(({ modelId }) => modelId === model).length !== 1) {
    failAcp("acp_model_option_ambiguous");
  }
  return matches[0];
}

function resolveExplicitOption(
  options: readonly ParsedConfigOption[],
  intent: AcpSessionConfigIntent,
): ParsedConfigOption {
  const matches = options.filter((option) => option.id === intent.configId);
  if (matches.length === 0) failAcp("acp_session_config_option_missing");
  if (matches.length !== 1) failAcp("acp_session_config_option_ambiguous");
  const option = matches[0];
  if (option.category !== intent.category || option.type !== intent.type) {
    failAcp("acp_session_config_option_shape_mismatch");
  }
  if (intent.type === "select") {
    const valueMatches = option.selectableValues.filter(({ modelId }) => modelId === intent.value);
    if (valueMatches.length === 0) failAcp("acp_session_config_value_missing");
    if (valueMatches.length !== 1) failAcp("acp_session_config_value_ambiguous");
  }
  return option;
}

function parseConfigOptions(value: unknown): readonly ParsedConfigOption[] {
  if (!Array.isArray(value)) failAcp("acp_session_config_options_missing");
  return value.map((entry) => {
    const option = asRecord(entry, "acp_session_config_option_invalid");
    if (typeof option.id !== "string" || !option.id) failAcp("acp_session_config_id_invalid");
    if (option.type !== "select" && option.type !== "boolean") {
      failAcp("acp_session_config_type_unsupported");
    }
    const category = typeof option.category === "string" ? option.category : undefined;
    if (option.type === "boolean") {
      if (typeof option.currentValue !== "boolean") {
        failAcp("acp_session_config_current_value_invalid");
      }
      return {
        id: option.id,
        category,
        type: "boolean" as const,
        currentValue: option.currentValue,
        selectableValues: [],
      };
    }
    if (typeof option.currentValue !== "string" || !Array.isArray(option.options)) {
      failAcp("acp_session_config_current_value_invalid");
    }
    return {
      id: option.id,
      category,
      type: "select" as const,
      currentValue: option.currentValue,
      selectableValues: flattenSelectValues(option.options),
    };
  });
}

function flattenSelectValues(options: readonly unknown[]): readonly AcpModelCatalogEntry[] {
  const values: AcpModelCatalogEntry[] = [];
  for (const entry of options) {
    const option = asRecord(entry, "acp_session_config_select_value_invalid");
    if (Array.isArray(option.options)) {
      values.push(...flattenSelectValues(option.options));
    } else if (typeof option.value === "string" && option.value) {
      values.push(Object.freeze({
        modelId: option.value,
        label: typeof option.name === "string" && option.name.trim()
          ? option.name.trim()
          : option.value,
      }));
    } else {
      failAcp("acp_session_config_select_value_invalid");
    }
  }
  if (new Set(values.map(({ modelId }) => modelId)).size !== values.length) {
    failAcp("acp_session_config_select_value_ambiguous");
  }
  return values;
}

function validateIntent(intent: AcpSessionConfigurationIntent): void {
  if (!intent || typeof intent.model !== "string" || !intent.model) {
    failAcp("acp_model_intent_invalid");
  }
  if (!Array.isArray(intent.options)) failAcp("acp_session_config_intent_invalid");
  const ids = new Set<string>();
  for (const option of intent.options) {
    if (!option.configId || !option.category) failAcp("acp_session_config_intent_invalid");
    if (ids.has(option.configId)) failAcp("acp_session_config_intent_duplicate");
    ids.add(option.configId);
    if (option.type === "select" && (typeof option.value !== "string" || !option.value)) {
      failAcp("acp_session_config_intent_invalid");
    }
    if (option.type === "boolean" && typeof option.value !== "boolean") {
      failAcp("acp_session_config_intent_invalid");
    }
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

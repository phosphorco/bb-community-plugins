import type { BbPluginApi, PluginRpcContract, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { bindBbIdentityRpcFoundation, type BbIdentityRpcFoundation } from '../bb-runtime.js';

type IncomingWire = { readonly body: string };
type DecodedInput = { readonly count: number };
type OutgoingWire = { readonly body: string };
type DecodedOutput = { readonly accepted: boolean };

const inputSchema: StandardSchemaV1<IncomingWire, DecodedInput> = {
  '~standard': { version: 1, vendor: 'integration-witness', validate: () => ({ issues: [] }) },
};
const outputSchema: StandardSchemaV1<OutgoingWire, DecodedOutput> = {
  '~standard': { version: 1, vendor: 'integration-witness', validate: () => ({ issues: [] }) },
};
const contract = {
  submit: { input: inputSchema, output: outputSchema },
} as const satisfies PluginRpcContract;

/** The installed SDK need not declare the optional experimental member for this to typecheck. */
const bindInstalledSdkApi: (bb: BbPluginApi) => ReturnType<typeof bindBbIdentityRpcFoundation> = bindBbIdentityRpcFoundation;

function compileOnly(foundation: BbIdentityRpcFoundation) {
  foundation.register(contract, {
    submit: {
      origin: 'interactive-user',
      handle(input, context) {
        const count: number = input.count;
        void context.scope;
        return { body: `${count}` };
      },
    },
  });

  foundation.register(contract, {
    submit: {
      origin: 'external',
      // @ts-expect-error Handler input is decoded output from the input schema, not wire input.
      handle: (input: IncomingWire) => ({ body: input.body }),
    },
  });
  foundation.register(contract, {
    submit: {
      origin: 'background',
      // @ts-expect-error Handler output must be the output schema's input/wire shape.
      handle: () => ({ accepted: true }),
    },
  });
}

void bindInstalledSdkApi;
void compileOnly;

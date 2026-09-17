import type { DiscoveryProvider, ProviderName } from '../types';
import { mapplsProvider } from './mappls';
import { olaProvider } from './ola';
import { googleProvider } from './google';
import { llmProvider } from './llm';

export const PROVIDERS: Record<ProviderName, DiscoveryProvider> = {
  mappls: mapplsProvider,
  ola: olaProvider,
  google: googleProvider,
  llm: llmProvider,
};

export { mapplsProvider, olaProvider, googleProvider, llmProvider };

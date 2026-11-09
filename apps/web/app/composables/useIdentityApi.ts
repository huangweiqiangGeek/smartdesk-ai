import { useNuxtApp } from '#app';
import type { RequestOptions } from '../services/api';

export function useIdentityApi() {
  const app = useNuxtApp();
  return <T>(path: string, options: RequestOptions = {}) =>
    app.$support.request<T>(path, options);
}

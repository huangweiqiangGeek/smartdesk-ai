import { defineNuxtPlugin, useRuntimeConfig } from '#app';
import { SupportClient } from '../services/support-client';

export default defineNuxtPlugin((app) => {
  const client = new SupportClient(useRuntimeConfig().public.socketBase);
  const visibility = () =>
    client.setVisible(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', visibility);
  visibility();
  const scope = (path: string) =>
    path.match(/^\/app\/o\/([^/]+)/)?.[0] ??
    path.match(/^\/widget\/([^/]+)/)?.[0] ??
    '';
  const removeGuard = app.$router.beforeEach((to, from) => {
    if (scope(to.path) !== scope(from.path)) client.setIdentity(null);
  });
  const pagehide = () => client.setIdentity(null);
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) window.location.reload();
  };
  const dispose = () => {
    removeGuard();
    document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('pagehide', pagehide);
    window.removeEventListener('pageshow', pageshow);
    client.destroy();
  };
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('pageshow', pageshow);
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return { provide: { support: client } };
});

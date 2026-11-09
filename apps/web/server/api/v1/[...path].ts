export default defineEventHandler((event) => {
  const base = useRuntimeConfig(event).apiBase;
  return proxyRequest(event, `${base}${event.path}`, {
    fetchOptions: { redirect: 'manual' },
  });
});

import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createApp(App).use(VueQueryPlugin, { queryClient }).mount('#app');

import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { createPinia } from 'pinia';
import Layout from './Layout.vue';
import PDFViewer from './components/PDFViewer.vue';
import ExternalHTMLViewer from './components/ExternalHTMLViewer.vue';
import './custom.css';

const pinia = createPinia();

const theme: Theme = {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.use(pinia);
    app.component('PDFViewer', PDFViewer);
    app.component('ExternalHTMLViewer', ExternalHTMLViewer);
  }
};

export default theme;

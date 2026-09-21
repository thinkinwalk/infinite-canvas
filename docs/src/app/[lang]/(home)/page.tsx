import type { Metadata } from 'next';
import {
  ArrowRight,
  BookOpen,
  Boxes,
  BrainCircuit,
  Code2,
  ImageIcon,
  Link2,
  MessageSquareText,
  Sparkles,
  Video,
  Waypoints,
  Zap,
} from 'lucide-react';
import type { Locale } from '@/lib/i18n';

const registerUrl = 'https://api.lingzhouai.com/register';
const docsUrl = 'https://api.lingzhouai.com/docs/';
const pricingUrl = 'https://api.lingzhouai.com/pricing';

const messages = {
  en: {
    banner: 'Welcome to Lingzhou AI, a unified API platform for leading AI models',
    registerNow: 'Create account',
    eyebrow: 'Unified AI model API gateway',
    title: 'Lingzhou AI',
    titleAccent: 'Model Service Platform',
    description: 'Connect leading chat, image, video, and reasoning models through one API for developer tools, intelligent applications, and creative workflows.',
    docs: 'Documentation',
    capabilities: ['Chat', 'Images', 'Video', 'Developer tools'],
    sectionTitle: 'A simpler way to use leading models',
    sectionDescription: 'Registration, API keys, model selection, and client setup all live in one platform.',
    viewModels: 'View models and pricing',
    features: [
      { title: 'Ready to use', description: 'Create an account and API key, then follow the documentation to connect your client.' },
      { title: 'Multi-model access', description: 'Choose from different models and routing groups according to each task.' },
      { title: 'Compatible APIs', description: 'Use familiar OpenAI- and Claude-compatible endpoints with less repeated setup.' },
    ],
    clientsTitle: 'Works with common clients and creative tools',
    clientsDescription: 'Configuration instructions are maintained in the Lingzhou AI documentation.',
  },
  'zh-CN': {
    banner: '欢迎使用灵舟 AI 大模型接口平台',
    registerNow: '立即注册',
    eyebrow: '统一的大模型接口网关',
    title: '灵舟 AI',
    titleAccent: '模型服务平台',
    description: '一个接口连接多种主流模型，为开发工具、智能应用与创作工作流提供对话、图片、视频和推理能力。',
    docs: '使用文档',
    capabilities: ['对话', '图片', '视频', '开发工具'],
    sectionTitle: '更简单地使用主流模型',
    sectionDescription: '从注册、创建令牌到客户端接入，统一在灵舟平台完成。',
    viewModels: '查看模型与价格',
    features: [
      { title: '开箱即用', description: '注册后创建 API Key，按照文档填写接口地址即可开始调用。' },
      { title: '多模型聚合', description: '在同一平台选择不同模型与分组，按任务需要灵活切换。' },
      { title: '统一兼容接口', description: '兼容常用 OpenAI 与 Claude 接入方式，减少重复配置成本。' },
    ],
    clientsTitle: '适配常用客户端与创作工具',
    clientsDescription: '具体配置方式统一收录在灵舟 AI 使用文档中。',
  },
};

const featureIcons = [Zap, Boxes, Waypoints];
const capabilityIcons = [MessageSquareText, ImageIcon, Video, Code2];

export default async function HomePage({ params }: PageProps<'/[lang]'>) {
  const { lang } = await params;
  const locale = lang as Locale;
  const text = messages[locale];

  return (
    <main className="flex flex-1 flex-col bg-white text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="flex min-h-9 items-center justify-center gap-2 bg-blue-50 px-5 py-2 text-center text-xs text-zinc-700 dark:bg-blue-950/40 dark:text-zinc-200">
        <Sparkles className="size-3.5 text-blue-600 dark:text-blue-400" />
        <span>{text.banner}</span>
        <a href={registerUrl} className="font-medium text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">
          {text.registerNow} →
        </a>
      </div>

      <section className="relative overflow-hidden border-b border-zinc-200 dark:border-zinc-800">
        <div className="relative mx-auto grid min-h-[500px] w-full max-w-6xl items-center gap-12 px-5 py-14 md:px-10 lg:grid-cols-[0.95fr_1.05fr] lg:gap-16">
          <div>
            <div className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
              <BrainCircuit className="size-4" />
              {text.eyebrow}
            </div>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-normal text-zinc-950 dark:text-white sm:text-5xl lg:text-6xl [font-family:var(--font-display)]">
              {text.title}
              <span className="mt-2 block text-blue-600 dark:text-blue-400">{text.titleAccent}</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-zinc-600 dark:text-zinc-400 sm:text-lg">
              {text.description}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={registerUrl} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-400">
                {text.registerNow}
                <ArrowRight className="size-4" />
              </a>
              <a href={docsUrl} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-5 py-3 text-sm font-medium text-zinc-900 transition hover:border-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:border-zinc-500 dark:hover:bg-zinc-900">
                <BookOpen className="size-4" />
                {text.docs}
              </a>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
              {text.capabilities.map((label, index) => {
                const Icon = capabilityIcons[index];
                return (
                  <span key={label} className="inline-flex items-center gap-1.5">
                    <Icon className="size-3.5" />
                    {label}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="relative mx-auto h-[350px] w-full max-w-[520px]" aria-label={locale === 'zh-CN' ? '灵舟 AI 聚合模型能力示意图' : 'Lingzhou AI model gateway diagram'}>
            <div className="absolute left-1/2 top-1/2 size-[280px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-zinc-300 dark:border-zinc-700 sm:size-[310px]" />
            <div className="absolute left-1/2 top-1/2 grid size-36 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-blue-200 bg-white shadow-[0_24px_60px_rgba(37,99,235,.16)] dark:border-blue-500/30 dark:bg-zinc-900">
              <div className="text-center">
                <img src="/lingzhou-logo.png" alt="" className="mx-auto size-11 rounded-full object-cover" />
                <strong className="mt-2 block text-sm font-semibold">Lingzhou API</strong>
              </div>
            </div>
            <CapabilityCard className="left-0 top-14" icon={MessageSquareText} label={text.capabilities[0]} />
            <CapabilityCard className="right-0 top-12" icon={ImageIcon} label={text.capabilities[1]} />
            <CapabilityCard className="bottom-16 left-0" icon={BrainCircuit} label={locale === 'zh-CN' ? '推理模型' : 'Reasoning'} />
            <CapabilityCard className="bottom-14 right-0" icon={Video} label={text.capabilities[2]} />
            <div className="absolute inset-x-4 bottom-0 flex min-h-10 items-center gap-2 overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 px-3 font-mono text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 sm:inset-x-14">
              <Link2 className="size-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
              <span className="truncate">https://api.lingzhouai.com/v1</span>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/45">
        <div className="mx-auto w-full max-w-6xl px-5 py-12 md:px-10">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">{text.sectionTitle}</h2>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{text.sectionDescription}</p>
            </div>
            <a href={pricingUrl} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200">
              {text.viewModels}
              <ArrowRight className="size-4" />
            </a>
          </div>
          <div className="mt-7 grid gap-4 md:grid-cols-3">
            {text.features.map((feature, index) => {
              const Icon = featureIcons[index];
              return (
                <article key={feature.title} className="min-h-36 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                  <span className="grid size-8 place-items-center rounded-md bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300">
                    <Icon className="size-4" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{feature.description}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-5 py-9 md:flex-row md:items-center md:justify-between md:px-10">
        <div>
          <h2 className="text-base font-semibold">{text.clientsTitle}</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{text.clientsDescription}</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-300">
          {['Claude Code', 'OpenAI Codex', 'RooCode', locale === 'zh-CN' ? '无限画布' : 'Infinite Canvas'].map((client) => (
            <span key={client} className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
              {client}
            </span>
          ))}
        </div>
      </section>
    </main>
  );
}

function CapabilityCard({ className, icon: Icon, label }: { className: string; icon: typeof MessageSquareText; label: string }) {
  return (
    <div className={`absolute inline-flex min-h-11 items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-xs font-medium shadow-[0_10px_24px_rgba(24,24,27,.08)] dark:border-zinc-700 dark:bg-zinc-900 ${className}`}>
      <Icon className="size-4 text-blue-600 dark:text-blue-400" />
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

export async function generateMetadata({ params }: PageProps<'/[lang]'>): Promise<Metadata> {
  const { lang } = await params;
  const locale = lang as Locale;
  const text = messages[locale];

  return {
    title: `${text.title} ${text.titleAccent}`,
    description: text.description,
    alternates: {
      languages: {
        en: '/',
        'zh-CN': '/zh-CN',
      },
    },
  };
}

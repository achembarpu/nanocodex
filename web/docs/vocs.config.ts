import { defineConfig } from "vocs/config";
import { docsBasePath } from "./site.js";

export default defineConfig({
  title: "Nanocodex",
  description: "A complete OpenAI coding agent, embedded in your product.",
  basePath: docsBasePath,
  baseUrl: "https://nanocodex.me-7fb.workers.dev",
  renderStrategy: "full-static",
  ogImageUrl: "https://nanocodex.me-7fb.workers.dev/og.png",
  topNav: [
    { text: "Guide", link: "/getting-started" },
    { text: "SDKs", link: "/sdks/rust" },
    { text: "Capabilities", link: "/capabilities/web-agent" },
    { text: "Evals", link: "/evals" },
    { text: "Live agent", link: "https://nanocodex.me-7fb.workers.dev" },
  ],
  sidebar: [
    {
      text: "Start",
      items: [
        { text: "Overview", link: "/" },
        { text: "Getting started", link: "/getting-started" },
        { text: "Stability and scope", link: "/stability" },
      ],
    },
    {
      text: "Core",
      items: [
        { text: "The owned agent", link: "/core/owned-agent" },
        { text: "Durable execution", link: "/core/durability" },
        { text: "Tools and Code Mode", link: "/core/tools-code-mode" },
        { text: "Branches and subagents", link: "/core/branching" },
      ],
    },
    {
      text: "SDKs",
      items: [
        { text: "Rust", link: "/sdks/rust" },
        { text: "JavaScript", link: "/sdks/javascript" },
        { text: "Python", link: "/sdks/python" },
      ],
    },
    {
      text: "Capabilities",
      items: [
        { text: "Web agent", link: "/capabilities/web-agent" },
        { text: "VMs and sandboxes", link: "/capabilities/vm-sandboxes" },
        { text: "Voice", link: "/capabilities/voice" },
        { text: "Deployment patterns", link: "/deployments" },
      ],
    },
    {
      text: "Proof",
      items: [
        { text: "Evaluation", link: "/evals" },
        { text: "Built with Nanocodex: Tact", link: "/examples/tact" },
      ],
    },
  ],
  socials: [
    { icon: "github", link: "https://github.com/gakonst/nanocodex" },
    { icon: "x", link: "https://x.com/gakonst" },
  ],
  editLink: {
    link: "https://github.com/gakonst/nanocodex/edit/master/web/docs/:path",
    text: "Edit this page on GitHub",
  },
});

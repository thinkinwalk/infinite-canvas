export type TaskConversationPhase = "discussion" | "proposal" | "candidate";

export type TaskConversationMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
};

export type TaskChangePlan = {
    summary: string;
    targets: { id: string; label: string }[];
    changes: { targetId: string; change: string; preserve: string }[];
    unchanged: string[];
    evidence?: { timeSeconds?: number; description: string }[];
};

export type TaskConversationQuote = {
    credits: number;
    calculation: string;
    details: string;
    contextKey: string;
    pricingKey: string;
};

export type TaskConversationContext = {
    business: string;
    taskTitle: string;
    subject: string;
    version?: string;
    source?: string;
    scope?: string;
    evidenceSummary?: string;
    evidence?: string;
    evidencePreviews?: { label: string; url: string }[];
    constraints?: string[];
};

export type TaskConversationCandidate = {
    status: "pending" | "applied" | "discarded";
    stale?: boolean;
    summary?: string;
    currentContent?: string;
    candidateContent?: string;
};

export type TaskConversation = {
    phase: TaskConversationPhase;
    messages: TaskConversationMessage[];
    plan?: TaskChangePlan;
    contextKey?: string;
};

export type TaskConversationAdapter = {
    context: Partial<TaskConversationContext> & { description: string };
    conversation?: TaskConversation;
    candidate?: TaskConversationCandidate;
    input: string;
    locked: boolean;
    busy: boolean;
    controls?: ReactNode;
    onInput: (value: string) => void;
    sendMessage: (quote?: TaskConversationQuote) => void | Promise<void>;
    organizePlan: (quote?: TaskConversationQuote) => void | Promise<void>;
    generateCandidate: (quote?: TaskConversationQuote) => void | Promise<void>;
    updatePlan?: (plan: TaskChangePlan) => void;
    applyCandidate?: () => void | Promise<void>;
    discardCandidate?: () => void | Promise<void>;
    undo?: () => void;
    prepareQuote?: (action: "message" | "plan" | "candidate") => Promise<TaskConversationQuote | null>;
};
import type { ReactNode } from "react";

import { useTrainHistory, type TrainHistory } from './useTrainHistory';

/** RVC 训练记录（共用 `useTrainHistory`，差异只在任务 kind 与文案） */
const OPTIONS = {
  kind: 'vc_train' as const,
  namePrefix: '变声训练：',
  modeLabels: { full: '全量微调', lora: 'LoRA 微调' },
  fallbackMode: '训练',
};

export type VcTrainHistory = TrainHistory;

export function useVcTrainHistory(limit = 30): VcTrainHistory {
  return useTrainHistory(OPTIONS, limit);
}

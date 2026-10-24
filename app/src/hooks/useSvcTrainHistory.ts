import { useTrainHistory, type TrainHistory } from './useTrainHistory';

/** DDSP-SVC 训练记录 */
const OPTIONS = {
  kind: 'svc_train' as const,
  namePrefix: '歌声转换训练：',
  modeLabels: { 'ddsp-svc': 'DDSP-SVC 训练' },
  fallbackMode: '训练',
};

export type SvcTrainHistory = TrainHistory;

export function useSvcTrainHistory(limit = 30): SvcTrainHistory {
  return useTrainHistory(OPTIONS, limit);
}

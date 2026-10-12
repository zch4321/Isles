import type { QuestionAnswer, QuestionDefinition } from '@isles/contracts';

const allow = '允许本次';
const reject = '拒绝';

/** Present a native permission request through the existing Isles question flow. */
export function permissionQuestions(text: string): QuestionDefinition[] {
  return [
    {
      id: 'permission',
      header: '执行授权',
      question: text,
      isOther: false,
      isSecret: false,
      multiSelect: false,
      options: [
        { label: allow, description: '允许当前原生权限请求。' },
        { label: reject, description: '拒绝当前原生权限请求。' },
      ],
    },
  ];
}

export function permissionAllowed(answer: QuestionAnswer): boolean {
  const values = answer.answers.permission?.answers;
  if (
    Object.keys(answer.answers).length !== 1 ||
    values?.length !== 1 ||
    ![allow, reject].includes(values[0]!)
  )
    throw new Error('请选择允许本次或拒绝。');
  return values[0] === allow;
}

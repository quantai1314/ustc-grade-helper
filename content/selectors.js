// 所有页面选择器集中于此。平台改版时只改这个文件。
// 现行命名 index__x--hash（2026-10 实测），兼容旧版 index_x-。
window.SELECTORS = {
  questionBlock: "[class^='index__subject--'], [class^='index_subject-']",
  requiredMark: "[class^='index__necessary--'], [class^='index_necessary']",
  title: "[class^='index__title--'], [class^='index_title']",
  titleCounter: "[class^='index__numCount--'], [class^='index_numCount']",
  optionRow: 'label.ant-radio-wrapper, label.ant-checkbox-wrapper',
  radioLabel: "label.ant-radio-wrapper",
  checkboxLabel: "label.ant-checkbox-wrapper",
  disabledLabel: '.ant-radio-wrapper-disabled, .ant-checkbox-wrapper-disabled',
  activeTeacher: ".ant-tabs-tab-active, [role='tab'][aria-selected='true']",
  teacherTab: '[role="tab"]',
  nextCourseText: '下一课程',
  taskTable: '.ant-tabs-tabpane-active .ant-table',
  taskNextPage: '.ant-pagination-next',
  loading: '.ant-spin-spinning, [aria-busy="true"]',
  submitDialog: '.ant-modal, .ant-modal-confirm, [role="dialog"]',
  submitSuccess: '.ant-message-success, .ant-notification-notice-success, [role="status"][data-submit-success]',
  submitError: '.ant-message-error, .ant-notification-notice-error, .ant-form-explain, .ant-alert-error',
  submitButton: "button[class*='index__submit'], button[class*='index_submit']",
  textarea: "textarea",
  ignoreButtonText: "忽略",
  confirmButton: "button.ant-btn-primary"
};

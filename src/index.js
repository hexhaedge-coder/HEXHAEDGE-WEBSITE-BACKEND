"use strict";
/**
 * The registry of everything the backend does: API actions (called by the
 * website at POST /api/<name>), payment webhooks (/hooks/...), and scheduled
 * jobs (run by cron.js). server.js and cron.js read this list.
 */

const profile = require("./profile");
const chamber = require("./chamber");
const booking = require("./booking");
const payments = require("./payments");
const build = require("./build");
const admin = require("./admin");
const media = require("./media");
const jobs = require("./jobs");

module.exports = {
  // profile, consent, service entry
  createProfile: profile.createProfile,
  setConsent: profile.setConsent,
  applyToService: profile.applyToService,
  decideApplication: profile.decideApplication,
  markMetMindspace: profile.markMetMindspace,
  exportMyData: profile.exportMyData,
  requestDeletion: profile.requestDeletion,

  // the Chamber
  savePlanDraft: chamber.savePlanDraft,
  submitPlan: chamber.submitPlan,
  decidePlan: chamber.decidePlan,
  requestUnlock: chamber.requestUnlock,
  decideUnlock: chamber.decideUnlock,
  beginUpload: chamber.beginUpload,
  submitRecord: chamber.submitRecord,
  reportUploadIssue: chamber.reportUploadIssue,
  markSubmission: chamber.markSubmission,
  confirmViolation: chamber.confirmViolation,
  dismissViolation: chamber.dismissViolation,
  intentRuling: chamber.intentRuling,
  reverseViolation: chamber.reverseViolation,
  respondToViolation: chamber.respondToViolation,
  requestEvidence: chamber.requestEvidence,
  submitEvidence: chamber.submitEvidence,
  recordEvidenceResult: chamber.recordEvidenceResult,
  requestResubmission: chamber.requestResubmission,
  requestPause: chamber.requestPause,
  clearToReturn: chamber.clearToReturn,
  returnFromPause: chamber.returnFromPause,
  clearSuspension: chamber.clearSuspension,
  leaveService: chamber.leaveService,
  disqualify: chamber.disqualify,
  adminSetState: chamber.adminSetState,
  getClipUrl: chamber.getClipUrl,

  // bookings (Chamber reviews and MindSpace)
  publishSlots: booking.publishSlots,
  closeSlot: booking.closeSlot,
  bookSlot: booking.bookSlot,
  cancelBooking: booking.cancelBooking,
  completeBooking: booking.completeBooking,
  reassignStaff: booking.reassignStaff,

  // payments (names avoid the word "mpesa": Daraja rejects such callback URLs)
  getInvoice: payments.getInvoice,
  startPayment: payments.startPayment,
  payConfirm: payments.payConfirm,
  payC2bValidate: payments.payC2bValidate,
  payC2bConfirm: payments.payC2bConfirm,
  registerC2bUrls: payments.registerC2bUrls,
  markPaidManually: payments.markPaidManually,
  matchPayment: payments.matchPayment,
  setInstalments: payments.setInstalments,

  // Build Your Edge
  saveTrainerProfile: build.saveTrainerProfile,
  trainerOptions: build.trainerOptions,
  chooseTrainer: build.chooseTrainer,
  updateTrainingSession: build.updateTrainingSession,
  requestMove: build.requestMove,
  saveStartingNote: build.saveStartingNote,
  saveProgressCheck: build.saveProgressCheck,
  combineSessions: build.combineSessions,
  suggestNextStep: build.suggestNextStep,

  // admin
  setRoles: admin.setRoles,
  updateSettings: admin.updateSettings,
  createInvitation: admin.createInvitation,
  revokeInvitation: admin.revokeInvitation,
  exportMemberData: admin.exportMemberData,
  deleteMemberData: admin.deleteMemberData,
  setOutageMode: admin.setOutageMode,
  resolveCase: admin.resolveCase,
  closeRequest: admin.closeRequest,

  // images
  avatarSignature: media.avatarSignature,
  setAvatar: media.setAvatar,

  // scheduled jobs
  createDailyObligations: jobs.createDailyObligations,
  quarterHourly: jobs.quarterHourly,
  timeoutCountdown: jobs.timeoutCountdown,
  bookingReminder: jobs.bookingReminder,
  bookingCutoff: jobs.bookingCutoff,
  weeklySummary: jobs.weeklySummary,
  daily: jobs.daily,
  healthCheck: jobs.healthCheck,
};

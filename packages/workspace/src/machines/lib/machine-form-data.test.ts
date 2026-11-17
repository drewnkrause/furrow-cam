import { describe, expect, it } from "vitest";
import { parseMachineForm } from "./machine-form-data";

function validFormData() {
  const form = new FormData();
  form.set("name", "Shark HD5");
  form.set("postProcessor", "grbl");
  form.set("workAreaX", "600");
  form.set("workAreaY", "600");
  form.set("workAreaZ", "150");
  form.set("safeZ", "10");
  form.set("entryClearance", "2");
  form.set("maxFeedXY", "2500");
  form.set("maxFeedZ", "1000");
  form.set("manualSpindle", "on");
  return form;
}

describe("parseMachineForm", () => {
  it("parses an optional fileExtension", () => {
    const form = validFormData();
    form.set("fileExtension", "tap");
    const result = parseMachineForm(form);
    expect(result.errors).toBeUndefined();
    expect(result.machine?.fileExtension).toBe("tap");

    const blankForm = validFormData();
    blankForm.set("fileExtension", "   ");
    const blankResult = parseMachineForm(blankForm);
    expect(blankResult.errors).toBeUndefined();
    expect(blankResult.machine?.fileExtension).toBeNull();
  });

  it("parses pathBlendingTolerance", () => {
    // Checkbox on without explicit tolerance defaults to true
    const formWithToggle = validFormData();
    formWithToggle.set("pathBlending", "on");
    const resultToggle = parseMachineForm(formWithToggle);
    expect(resultToggle.errors).toBeUndefined();
    expect(resultToggle.machine?.pathBlendingTolerance).toBe(true);

    // Checkbox on with custom number
    const formWithNumber = validFormData();
    formWithNumber.set("pathBlending", "on");
    formWithNumber.set("pathBlendingTolerance", "0.15");
    const resultNumber = parseMachineForm(formWithNumber);
    expect(resultNumber.errors).toBeUndefined();
    expect(resultNumber.machine?.pathBlendingTolerance).toBe(0.15);

    // Checkbox off leaves tolerance null
    const formWithoutToggle = validFormData();
    const resultOff = parseMachineForm(formWithoutToggle);
    expect(resultOff.errors).toBeUndefined();
    expect(resultOff.machine?.pathBlendingTolerance).toBeNull();
  });

  it("reports an error for invalid fileExtension or negative tolerance", () => {
    const formInvalidExt = validFormData();
    formInvalidExt.set("fileExtension", "bad extension with spaces!");
    const resultExt = parseMachineForm(formInvalidExt);
    expect(resultExt.errors?.fileExtension).toBeDefined();

    const formNegativeTol = validFormData();
    formNegativeTol.set("pathBlending", "on");
    formNegativeTol.set("pathBlendingTolerance", "-0.5");
    const resultTol = parseMachineForm(formNegativeTol);
    expect(resultTol.errors?.pathBlendingTolerance).toBeDefined();
  });
});

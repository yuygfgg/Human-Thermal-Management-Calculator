import { useEffect, useId, useMemo, useRef, useState } from "react";

import { CLOTHING_PRESETS } from "../data/clothing";
import { createGarment } from "../data/templates";
import { calculateClothingInsulation } from "../domain/clothing";
import {
  ACTIVITY_PRESETS,
  CATEGORY_LABELS,
  POSTURE_LABELS,
  SOLAR_RADIATION_PRESETS,
} from "../domain/constants";
import { SCENARIO_LIMITS } from "../domain/scenario";
import {
  duplicateStage,
  moveStage,
  removeStage,
  updateStage,
} from "../domain/scenarioEditing";
import {
  CLOTHING_SEGMENTS,
  type ClothingSegment,
  type ClothingCategory,
  type GarmentInstance,
  type Language,
  type ScalarProfile,
  type ScenarioStage,
  type ScenarioValidationIssue,
  type SimulationScenario,
  type Subject,
} from "../domain/types";

interface ScenarioPanelProps {
  scenario: SimulationScenario;
  selectedStageId: string;
  issues: ScenarioValidationIssue[];
  language: Language;
  onChange: (scenario: SimulationScenario) => void;
  onSelectStage: (stageId: string) => void;
}

const COPY = {
  zh: {
    subject: "人体参数",
    sex: "生理性别",
    female: "女性",
    male: "男性",
    height: "身高",
    weight: "体重",
    age: "年龄",
    referenceCore: "舒适度参考核心温度",
    referenceHint: "仅用于舒适度评分。",
    schedule: "场景时间线",
    total: "总时长",
    stage: "阶段",
    addStage: "复制当前阶段",
    moveUp: "前移",
    moveDown: "后移",
    duplicate: "复制",
    remove: "删除",
    duration: "持续时间",
    environment: "环境条件",
    airTemp: "空气温度",
    wind: "风速",
    humidity: "相对湿度",
    solar: "太阳辐射",
    solarPreset: "日照条件",
    customSolar: "自定义数值",
    mediumK: "介质导热率",
    advanced: "高级环境参数",
    activity: "活动与姿势",
    activityPreset: "活动预设",
    custom: "自定义",
    met: "活动强度",
    posture: "姿势",
    changes: "阶段内变化",
    start: "起值",
    end: "终值",
    outfit: "阶段穿搭",
    addGarment: "添加衣物",
    add: "添加",
    thickness: "厚度",
    thin: "薄款",
    normal: "标准",
    thick: "厚款",
    emptyOutfit: "该阶段没有衣物。",
    editRegionalClo: "编辑分区 clo",
    collapseRegionalClo: "收起分区 clo",
    regionalClo: "分区 clo",
    regionalCloHint: "基础 clo；0 表示未覆盖。",
    ensembleClo: "ISO 9920 组合隔热",
    garmentSum: "单件加权和",
    validation: "请修正以下输入",
    minutes: "分钟",
  },
  en: {
    subject: "Subject",
    sex: "Physiological sex",
    female: "Female",
    male: "Male",
    height: "Height",
    weight: "Weight",
    age: "Age",
    referenceCore: "Comfort reference core temperature",
    referenceHint: "Used only for comfort scoring.",
    schedule: "Scenario timeline",
    total: "Total duration",
    stage: "Stage",
    addStage: "Duplicate selected stage",
    moveUp: "Move earlier",
    moveDown: "Move later",
    duplicate: "Duplicate",
    remove: "Delete",
    duration: "Duration",
    environment: "Environment",
    airTemp: "Air temperature",
    wind: "Air speed",
    humidity: "Relative humidity",
    solar: "Solar radiation",
    solarPreset: "Sun condition",
    customSolar: "Custom value",
    mediumK: "Medium thermal conductivity",
    advanced: "Advanced environment settings",
    activity: "Activity and posture",
    activityPreset: "Activity preset",
    custom: "Custom",
    met: "Activity intensity",
    posture: "Posture",
    changes: "Changes during stage",
    start: "Start",
    end: "End",
    outfit: "Stage outfit",
    addGarment: "Add garment",
    add: "Add",
    thickness: "Thickness",
    thin: "Thin",
    normal: "Standard",
    thick: "Thick",
    emptyOutfit: "This stage has no garments.",
    editRegionalClo: "Edit regional clo",
    collapseRegionalClo: "Collapse regional clo",
    regionalClo: "Regional clo",
    regionalCloHint: "Base clo; zero means no coverage.",
    ensembleClo: "ISO 9920 ensemble insulation",
    garmentSum: "Weighted garment sum",
    validation: "Correct these inputs",
    minutes: "min",
  },
} as const;

const CLOTHING_SEGMENT_LABELS: Readonly<Record<ClothingSegment, Record<Language, string>>> = {
  Head: { zh: "头部", en: "Head" },
  Neck: { zh: "颈部", en: "Neck" },
  Chest: { zh: "胸部", en: "Chest" },
  Back: { zh: "背部", en: "Back" },
  Pelvis: { zh: "骨盆", en: "Pelvis" },
  Shoulder: { zh: "肩部", en: "Shoulder" },
  Arm: { zh: "上臂", en: "Arm" },
  Hand: { zh: "手部", en: "Hand" },
  Thigh: { zh: "大腿", en: "Thigh" },
  Leg: { zh: "小腿", en: "Lower leg" },
  Foot: { zh: "足部", en: "Foot" },
};

function formatCompact(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(2)).toString() : "—";
}

interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumberField({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lastValidValue = useRef(value);

  useEffect(() => {
    if (!Object.is(value, lastValidValue.current)) {
      lastValidValue.current = value;
      if (inputRef.current) {
        inputRef.current.value = formatNumberFieldDraft(value);
      }
    }
  }, [value]);

  return (
    <label className="field">
      <span className="field__label">
        {label}
        {unit ? <span className="field__unit">{unit}</span> : null}
      </span>
      <input
        ref={inputRef}
        type="number"
        defaultValue={formatNumberFieldDraft(value)}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const nextValue = event.currentTarget.valueAsNumber;

          if (!Number.isFinite(nextValue)) {
            return;
          }

          lastValidValue.current = nextValue;
          onChange(nextValue);
        }}
        onBlur={(event) => {
          if (Number.isFinite(event.currentTarget.valueAsNumber)) {
            return;
          }

          event.currentTarget.value = formatNumberFieldDraft(lastValidValue.current);
        }}
      />
    </label>
  );
}

function formatNumberFieldDraft(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function regionalCloDraft(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function RegionalCloField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(() => regionalCloDraft(value));
  const committedValue = useRef(value);

  useEffect(() => {
    if (!Object.is(value, committedValue.current)) {
      setDraft(regionalCloDraft(value));
      committedValue.current = value;
    }
  }, [value]);

  return (
    <label className="field">
      <span className="field__label">
        {label}
        <span className="field__unit">clo</span>
      </span>
      <input
        type="number"
        value={draft}
        placeholder="0"
        min={SCENARIO_LIMITS.clothingClo.minimum}
        max={SCENARIO_LIMITS.clothingClo.maximum}
        step={0.01}
        onChange={(event) => {
          const nextDraft = event.currentTarget.value;
          setDraft(nextDraft);

          if (nextDraft === "") {
            committedValue.current = undefined;
            onChange(undefined);
            return;
          }

          const parsedValue = event.currentTarget.valueAsNumber;
          if (Number.isFinite(parsedValue)) {
            const nextValue = parsedValue === 0 ? undefined : parsedValue;
            committedValue.current = nextValue;
            onChange(nextValue);
          }
        }}
      />
    </label>
  );
}

interface ProfileFieldProps extends Omit<NumberFieldProps, "value" | "onChange"> {
  profile: ScalarProfile;
  language: Language;
  onChange: (profile: ScalarProfile) => void;
}

function ProfileField({
  profile,
  language,
  onChange,
  ...fieldProps
}: ProfileFieldProps) {
  const copy = COPY[language];
  const varies = !Object.is(profile.start, profile.end);

  return (
    <div className={`profile-field${varies ? " profile-field--varies" : ""}`}>
      <NumberField
        {...fieldProps}
        label={varies ? `${fieldProps.label} · ${copy.start}` : fieldProps.label}
        value={profile.start}
        onChange={(start) => onChange({ start, end: varies ? profile.end : start })}
      />
      {varies ? (
        <NumberField
          {...fieldProps}
          label={`${fieldProps.label} · ${copy.end}`}
          value={profile.end}
          onChange={(end) => onChange({ ...profile, end })}
        />
      ) : null}
      <label className="profile-field__toggle">
        <input
          type="checkbox"
          checked={varies}
          onChange={(event) => onChange({
            start: profile.start,
            end: event.target.checked ? profile.start + (fieldProps.step ?? 1) : profile.start,
          })}
        />
        <span>{copy.changes}</span>
      </label>
    </div>
  );
}

function SolarRadiationField({
  profile,
  language,
  onChange,
}: {
  profile: ScalarProfile;
  language: Language;
  onChange: (profile: ScalarProfile) => void;
}) {
  const copy = COPY[language];
  const matchedPreset = SOLAR_RADIATION_PRESETS.find((preset) => (
    profile.start === profile.end && profile.start === preset.valueWm2
  ));
  const [customMode, setCustomMode] = useState(!matchedPreset);
  const pendingProfile = useRef<ScalarProfile | null>(null);
  const selectedValue = customMode || !matchedPreset ? "custom" : matchedPreset.id;

  useEffect(() => {
    const pending = pendingProfile.current;
    pendingProfile.current = null;

    if (
      pending
      && Object.is(pending.start, profile.start)
      && Object.is(pending.end, profile.end)
    ) {
      return;
    }

    setCustomMode(!matchedPreset);
  }, [matchedPreset, profile]);

  const commitProfile = (nextProfile: ScalarProfile, keepCustomMode: boolean) => {
    pendingProfile.current = nextProfile;
    setCustomMode(keepCustomMode);
    onChange(nextProfile);
  };

  return (
    <div className="solar-profile-field" role="group" aria-label={copy.solar}>
      <label className="field">
        <span className="field__label">{copy.solarPreset}</span>
        <select
          value={selectedValue}
          onChange={(event) => {
            if (event.target.value === "custom") {
              setCustomMode(true);
              return;
            }

            const preset = SOLAR_RADIATION_PRESETS.find((candidate) => (
              candidate.id === event.target.value
            ));
            if (preset) {
              commitProfile(
                { start: preset.valueWm2, end: preset.valueWm2 },
                false,
              );
            }
          }}
        >
          <option value="custom">{copy.customSolar}</option>
          {SOLAR_RADIATION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label[language]} · {preset.valueWm2} W/m²
            </option>
          ))}
        </select>
      </label>
      {selectedValue === "custom" ? (
        <ProfileField
          label={copy.solar}
          unit="W/m²"
          profile={profile}
          language={language}
          min={0}
          max={2000}
          step={50}
          onChange={(nextProfile) => commitProfile(nextProfile, true)}
        />
      ) : null}
    </div>
  );
}

function SubjectEditor({
  subject,
  language,
  onChange,
}: {
  subject: Subject;
  language: Language;
  onChange: (subject: Subject) => void;
}) {
  const copy = COPY[language];
  const set = <K extends keyof Subject>(key: K, value: Subject[K]) => {
    onChange({ ...subject, [key]: value });
  };

  return (
    <section className="panel-section subject-editor" aria-labelledby="subject-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">01</p>
          <h2 id="subject-title">{copy.subject}</h2>
        </div>
      </div>
      <div className="field-grid field-grid--subject">
        <label className="field">
          <span className="field__label">{copy.sex}</span>
          <select
            value={subject.sex}
            onChange={(event) => set("sex", event.target.value as Subject["sex"])}
          >
            <option value="female">{copy.female}</option>
            <option value="male">{copy.male}</option>
          </select>
        </label>
        <NumberField label={copy.height} unit="cm" value={subject.heightCm} min={100} max={250} onChange={(value) => set("heightCm", value)} />
        <NumberField label={copy.weight} unit="kg" value={subject.weightKg} min={20} max={350} step={0.1} onChange={(value) => set("weightKg", value)} />
        <NumberField label={copy.age} unit={language === "zh" ? "岁" : "years"} value={subject.ageYears} min={1} max={120} onChange={(value) => set("ageYears", value)} />
        <NumberField label={copy.referenceCore} unit="°C" value={subject.referenceCoreTempC} min={30} max={42} step={0.1} onChange={(value) => set("referenceCoreTempC", value)} />
      </div>
      <p className="field-note">{copy.referenceHint}</p>
    </section>
  );
}

function StageTimeline({
  scenario,
  selectedStageId,
  language,
  onSelect,
}: {
  scenario: SimulationScenario;
  selectedStageId: string;
  language: Language;
  onSelect: (stageId: string) => void;
}) {
  const copy = COPY[language];
  let elapsed = 0;
  return (
    <div className="stage-timeline" role="list" aria-label={copy.schedule}>
      {scenario.stages.map((stage, index) => {
        const start = elapsed;
        elapsed += stage.durationMin;
        const insulation = calculateClothingInsulation(stage.outfit);
        return (
          <button
            key={stage.id}
            type="button"
            role="listitem"
            className={`stage-card${stage.id === selectedStageId ? " stage-card--selected" : ""}`}
            onClick={() => onSelect(stage.id)}
          >
            <span className="stage-card__index">{String(index + 1).padStart(2, "0")}</span>
            <span className="stage-card__body">
              <strong>{stage.name || `${copy.stage} ${index + 1}`}</strong>
              <span>{start}–{elapsed} {copy.minutes}</span>
              <span>{formatCompact(stage.environment.airTempC.start)}° → {formatCompact(stage.environment.airTempC.end)}° · {formatCompact(stage.activityMet.start)} met</span>
            </span>
            <span className="stage-card__clo">{insulation.ensembleInsulationClo.toFixed(2)} clo</span>
          </button>
        );
      })}
    </div>
  );
}

function OutfitEditor({
  stage,
  language,
  onChange,
}: {
  stage: ScenarioStage;
  language: Language;
  onChange: (outfit: GarmentInstance[]) => void;
}) {
  const copy = COPY[language];
  const [presetId, setPresetId] = useState(CLOTHING_PRESETS[0].id);
  const [modifier, setModifier] = useState(1);
  const [expandedGarment, setExpandedGarment] = useState<{
    stageId: string;
    instanceId: string;
  } | null>(null);
  const regionalEditorIdPrefix = useId().replaceAll(":", "");
  const insulation = useMemo(() => calculateClothingInsulation(stage.outfit), [stage.outfit]);
  const grouped = useMemo(() => {
    const groups = new Map<ClothingCategory, typeof CLOTHING_PRESETS>();
    for (const preset of CLOTHING_PRESETS) {
      const group = groups.get(preset.category) ?? [];
      group.push(preset);
      groups.set(preset.category, group);
    }
    return groups;
  }, []);

  const garmentName = (garment: GarmentInstance) => (
    language === "zh" ? garment.nameZh : garment.nameEn
  );

  const isGarmentExpanded = (instanceId: string) => (
    expandedGarment?.stageId === stage.id
    && expandedGarment.instanceId === instanceId
  );

  const updateGarment = (
    instanceId: string,
    update: (garment: GarmentInstance) => GarmentInstance,
  ) => onChange(stage.outfit.map((garment) => (
    garment.instanceId === instanceId ? update(garment) : garment
  )));

  const updateSegmentClo = (
    instanceId: string,
    segment: ClothingSegment,
    value: number | undefined,
  ) => updateGarment(instanceId, (garment) => {
    const segmentClo = { ...garment.segmentClo };
    if (value === undefined) {
      delete segmentClo[segment];
    } else {
      segmentClo[segment] = value;
    }
    return { ...garment, segmentClo };
  });

  return (
    <section className="editor-block outfit-editor" aria-labelledby="outfit-title">
      <div className="editor-block__heading">
        <div>
          <h3 id="outfit-title">{copy.outfit}</h3>
          <p>{copy.ensembleClo}: <strong>{insulation.ensembleInsulationClo.toFixed(2)} clo</strong> · {copy.garmentSum}: {insulation.garmentInsulationSumClo.toFixed(2)} clo</p>
        </div>
      </div>
      <div className="garment-add-row">
        <label className="field field--grow">
          <span className="field__label">{copy.addGarment}</span>
          <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
            {[...grouped.entries()].map(([category, presets]) => (
              <optgroup key={category} label={CATEGORY_LABELS[category][language]}>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {language === "zh" ? preset.nameZh : preset.nameEn}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field garment-add-row__modifier">
          <span className="field__label">{copy.thickness}</span>
          <select value={modifier} onChange={(event) => setModifier(Number(event.target.value))}>
            <option value={0.75}>{copy.thin}</option>
            <option value={1}>{copy.normal}</option>
            <option value={1.25}>{copy.thick}</option>
          </select>
        </label>
        <button type="button" className="button button--secondary garment-add-row__button" onClick={() => onChange([...stage.outfit, createGarment(presetId, modifier)])}>
          {copy.add}
        </button>
      </div>
      {stage.outfit.length === 0 ? (
        <p className="empty-state">{copy.emptyOutfit}</p>
      ) : (
        <ul className="garment-list">
          {stage.outfit.map((garment, garmentIndex) => {
            const editorId = `${regionalEditorIdPrefix}-regional-clo-${garmentIndex}`;
            const editorHintId = `${editorId}-hint`;
            return (
              <li key={`${stage.id}-${garment.instanceId}`}>
                <button
                  type="button"
                  className="button button--quiet garment-list__edit-button"
                  aria-expanded={isGarmentExpanded(garment.instanceId)}
                  aria-controls={editorId}
                  aria-label={`${isGarmentExpanded(garment.instanceId)
                    ? copy.collapseRegionalClo
                    : copy.editRegionalClo}: ${garmentName(garment)}`}
                  onClick={() => setExpandedGarment((current) => (
                    current?.stageId === stage.id && current.instanceId === garment.instanceId
                      ? null
                      : { stageId: stage.id, instanceId: garment.instanceId }
                  ))}
                >
                  <span className="garment-list__name">{garmentName(garment)}</span>
                  <span className="garment-list__edit-label">
                    {isGarmentExpanded(garment.instanceId)
                      ? copy.collapseRegionalClo
                      : copy.editRegionalClo}
                  </span>
                  <span className="garment-list__edit-icon" aria-hidden="true">
                    {isGarmentExpanded(garment.instanceId) ? "−" : "+"}
                  </span>
                </button>
                <select
                  aria-label={`${garmentName(garment)} · ${copy.thickness}`}
                  value={garment.modifier}
                  onChange={(event) => updateGarment(garment.instanceId, (candidate) => ({
                    ...candidate,
                    modifier: Number(event.target.value),
                  }))}
                >
                  <option value={0.75}>{copy.thin}</option>
                  <option value={1}>{copy.normal}</option>
                  <option value={1.25}>{copy.thick}</option>
                </select>
                <button
                  type="button"
                  className="icon-button icon-button--danger"
                  aria-label={`${copy.remove}: ${garmentName(garment)}`}
                  onClick={() => {
                    if (isGarmentExpanded(garment.instanceId)) {
                      setExpandedGarment(null);
                    }
                    onChange(stage.outfit.filter((candidate) => (
                      candidate.instanceId !== garment.instanceId
                    )));
                  }}
                >
                  ×
                </button>
                {isGarmentExpanded(garment.instanceId) ? (
                  <div
                    id={editorId}
                    className="garment-list__regional-editor"
                    role="group"
                    aria-label={`${copy.regionalClo}: ${garmentName(garment)}`}
                    aria-describedby={editorHintId}
                  >
                    <p id={editorHintId} className="field-note">{copy.regionalCloHint}</p>
                    <div className="field-grid garment-list__segment-grid">
                      {CLOTHING_SEGMENTS.map((segment) => (
                        <RegionalCloField
                          key={segment}
                          label={CLOTHING_SEGMENT_LABELS[segment][language]}
                          value={garment.segmentClo[segment]}
                          onChange={(value) => updateSegmentClo(
                            garment.instanceId,
                            segment,
                            value,
                          )}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function StageEditor({
  stage,
  language,
  onChange,
}: {
  stage: ScenarioStage;
  language: Language;
  onChange: (stage: ScenarioStage) => void;
}) {
  const copy = COPY[language];
  const matchedActivity = ACTIVITY_PRESETS.find((preset) => (
    stage.activityMet.start === stage.activityMet.end
    && Math.abs(stage.activityMet.start - preset.met) < 0.001
    && stage.posture === preset.posture
  ));

  const updateEnvironment = <K extends keyof ScenarioStage["environment"]>(
    key: K,
    value: ScenarioStage["environment"][K],
  ) => onChange({
    ...stage,
    environment: { ...stage.environment, [key]: value },
  });

  return (
    <div className="stage-editor">
      <div className="field-grid field-grid--stage-meta">
        <label className="field field--wide">
          <span className="field__label">{copy.stage}</span>
          <input value={stage.name} onChange={(event) => onChange({ ...stage, name: event.target.value })} />
        </label>
        <NumberField
          label={copy.duration}
          unit={copy.minutes}
          value={stage.durationMin}
          min={SCENARIO_LIMITS.durationMin.minimum}
          max={SCENARIO_LIMITS.durationMin.maximum}
          onChange={(durationMin) => onChange({ ...stage, durationMin })}
        />
      </div>

      <section className="editor-block" aria-labelledby="environment-title">
        <div className="editor-block__heading"><h3 id="environment-title">{copy.environment}</h3></div>
        <div className="profile-grid">
          <ProfileField label={copy.airTemp} unit="°C" profile={stage.environment.airTempC} language={language} min={-60} max={80} step={1} onChange={(profile) => updateEnvironment("airTempC", profile)} />
          <ProfileField label={copy.wind} unit="m/s" profile={stage.environment.windSpeedMs} language={language} min={0} max={60} step={0.1} onChange={(profile) => updateEnvironment("windSpeedMs", profile)} />
          <ProfileField label={copy.humidity} unit="%" profile={stage.environment.relativeHumidityPercent} language={language} min={0} max={100} step={1} onChange={(profile) => updateEnvironment("relativeHumidityPercent", profile)} />
          <SolarRadiationField key={stage.id} profile={stage.environment.solarRadiationWm2} language={language} onChange={(profile) => updateEnvironment("solarRadiationWm2", profile)} />
        </div>
        <details className="advanced-settings">
          <summary>{copy.advanced}</summary>
          <div className="profile-grid profile-grid--advanced">
            <ProfileField label={copy.mediumK} unit="W/(m·K)" profile={stage.environment.mediumThermalConductivityWmK} language={language} min={0.001} max={500} step={0.001} onChange={(profile) => updateEnvironment("mediumThermalConductivityWmK", profile)} />
          </div>
        </details>
      </section>

      <section className="editor-block" aria-labelledby="activity-title">
        <div className="editor-block__heading"><h3 id="activity-title">{copy.activity}</h3></div>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">{copy.posture}</span>
            <select value={stage.posture} onChange={(event) => onChange({ ...stage, posture: event.target.value as ScenarioStage["posture"] })}>
              {Object.entries(POSTURE_LABELS).map(([value, labels]) => <option key={value} value={value}>{labels[language]}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{copy.activityPreset}</span>
            <select
              value={matchedActivity?.id ?? "custom"}
              onChange={(event) => {
                const preset = ACTIVITY_PRESETS.find((candidate) => candidate.id === event.target.value);
                if (preset) {
                  onChange({ ...stage, activityMet: { start: preset.met, end: preset.met }, posture: preset.posture });
                }
              }}
            >
              <option value="custom">{copy.custom}</option>
              {ACTIVITY_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label[language]} · {preset.met} met</option>)}
            </select>
          </label>
        </div>
        <div className="profile-grid profile-grid--activity">
          <ProfileField label={copy.met} unit="met" profile={stage.activityMet} language={language} min={0.8} max={12} step={0.1} onChange={(activityMet) => onChange({ ...stage, activityMet })} />
        </div>
      </section>

      <OutfitEditor stage={stage} language={language} onChange={(outfit) => onChange({ ...stage, outfit })} />
    </div>
  );
}

export function ScenarioPanel({
  scenario,
  selectedStageId,
  issues,
  language,
  onChange,
  onSelectStage,
}: ScenarioPanelProps) {
  const copy = COPY[language];
  const selectedStage = scenario.stages.find((stage) => stage.id === selectedStageId)
    ?? scenario.stages[0];
  const selectedIndex = scenario.stages.findIndex((stage) => stage.id === selectedStage.id);
  const totalDuration = scenario.stages.reduce((sum, stage) => sum + stage.durationMin, 0);

  const handleDuplicate = () => {
    const result = duplicateStage(
      scenario,
      selectedStage.id,
      `${selectedStage.name} ${language === "zh" ? "副本" : "copy"}`,
    );
    onChange(result.scenario);
    onSelectStage(result.stageId);
  };

  const handleRemove = () => {
    const result = removeStage(scenario, selectedStage.id);
    onChange(result.scenario);
    onSelectStage(result.stageId);
  };

  return (
    <aside className="scenario-panel" aria-label={copy.schedule}>
      <SubjectEditor subject={scenario.subject} language={language} onChange={(subject) => onChange({ ...scenario, subject })} />

      <section className="panel-section schedule-editor" aria-labelledby="schedule-title">
        <div className="section-heading section-heading--split">
          <div>
            <p className="eyebrow">02</p>
            <h2 id="schedule-title">{copy.schedule}</h2>
          </div>
          <span className={`duration-badge${totalDuration > 1440 ? " duration-badge--error" : ""}`}>
            {copy.total} {totalDuration} {copy.minutes}
          </span>
        </div>

        {issues.length > 0 ? (
          <div className="validation-summary" role="alert">
            <strong>{copy.validation}</strong>
            <ul>{issues.slice(0, 5).map((issue) => <li key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>)}</ul>
          </div>
        ) : null}

        <StageTimeline scenario={scenario} selectedStageId={selectedStage.id} language={language} onSelect={onSelectStage} />
        <div className="stage-actions" role="toolbar" aria-label={copy.stage}>
          <button type="button" className="button button--quiet" disabled={selectedIndex <= 0} onClick={() => onChange(moveStage(scenario, selectedStage.id, -1))}>↑ {copy.moveUp}</button>
          <button type="button" className="button button--quiet" disabled={selectedIndex >= scenario.stages.length - 1} onClick={() => onChange(moveStage(scenario, selectedStage.id, 1))}>↓ {copy.moveDown}</button>
          <button type="button" className="button button--quiet" onClick={handleDuplicate}>＋ {copy.duplicate}</button>
          <button type="button" className="button button--quiet button--danger" disabled={scenario.stages.length <= 1} onClick={handleRemove}>× {copy.remove}</button>
        </div>

        <StageEditor
          stage={selectedStage}
          language={language}
          onChange={(stage) => onChange(updateStage(scenario, selectedStage.id, () => stage))}
        />
      </section>
    </aside>
  );
}

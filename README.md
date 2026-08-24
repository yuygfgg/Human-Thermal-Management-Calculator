# Human Thermal Management Calculator

**Scientifically prove you're not cold (or hot).**

Human Thermal Management Calculator is a browser-based workbench for multi-stage thermal physiology simulations.

## Main functions

- Create, duplicate, remove, and reorder scenario stages.
- Set constant values or linear start-to-end profiles for each stage.
- Assign a separate outfit to each stage and calculate ISO 9920 ensemble insulation.
- Run one continuous JOS-3 simulation for the complete scenario.
- Inspect skin temperature, core temperature, wettedness, skin blood flow, shivering heat, sweat evaporation, skin heat loss, and clothing insulation on a 17-node body map.
- Link the body map, time control, stage markers, regional details, and trend charts.
- View whole-body temperature, heat balance, physiological responses, stage summaries, and raw JOS-3 data.
- Switch between Chinese and English and between light and dark themes.

## Run the workbench

Open <https://calc.yuygfgg.xyz/>.

1. Select a template or edit the current scenario, or load from a JSON file.
2. Set the subject values.
3. Add and arrange the required stages.
4. Set the duration, conditions, activity, posture, and outfit for each stage.
5. Select Run scenario.
6. Use the time control and body map to inspect the result.
7. Export the result as a CSV file or save parameters as a JSON file.

## Development

Install the front-end packages:

```bash
npm ci
```

Start the Vite development server:

```bash
npm run dev
```

Open the URL that Vite prints. Do not open `index.html` through a `file://` URL. The Web Worker and simulation assets require HTTP.

Install the Python test dependencies in a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Scenario protocol

The version 1 scenario JSON exported by the workbench is the only public
simulation input format. The browser worker and native Python code accept the
same document. Shared limits, segment mappings, and clothing insulation
constants are defined in `scenario-contract.json`.

Run an exported scenario with Python:

```python
import json

from simulation_core import simulate_scenario

with open("scenario.json", encoding="utf-8") as file:
    result = simulate_scenario(json.load(file))
```

## Tests

Run the TypeScript check:

```bash
npm run check
```

Run the front-end unit and component tests:

```bash
npm test
```

Run the Python simulation tests:

```bash
python -m unittest discover -s tests -p 'test_simulation_core.py' -v
```

Create a production build:

```bash
npm run build
```

Vite writes the static site to `dist`.

## Static deployment

Serve the complete `dist` directory from one HTTP or HTTPS origin. Keep the copied worker, Python core, and wheel at their generated relative paths.

Test the production build locally:

```bash
npm run preview
```

You can also use a basic static server:

```bash
python3 -m http.server 8000 --directory dist
```

Then open <http://127.0.0.1:8000/>.

### License

This project is released under the terms of the **GNU Affero General Public License, version&nbsp;3.0** (AGPL-3.0) or (at your option) any later version.

The warranty limitations and liability exclusions stated in the "Important Legal Disclaimer" section below are **consistent with, and in addition to,** the warranty and liability clauses contained in Sections&nbsp;15 and&nbsp;16 of the AGPL-3.0; they do **not** reduce or restrict any rights granted to you by the license.

A copy of the full license text is provided in the `LICENSE` file of this repository and online at <https://www.gnu.org/licenses/agpl-3.0.html>.

### Important Legal Disclaimer

The Human Thermal Management Calculator (the "Application") is an experimental, non-commercial proof-of-concept provided strictly for academic, research, and general informational purposes. It does NOT constitute medical or clinical advice, is NOT a substitute for professional healthcare judgment, and must NOT be relied upon for any health-related decision.

By accessing or using this Application you expressly acknowledge and agree that:

1. **No Medical Device.** The Application has not been reviewed, cleared, or approved by the U.S. Food and Drug Administration or any other regulatory body. It is NOT intended to diagnose, treat, cure, or prevent any disease or medical condition.

2. **Model Limitations.** The underlying algorithms are simplified biothermal models that omit numerous physiological, environmental, and individual factors. Output values are approximate and may deviate substantially from real-world conditions.

3. **Personal Responsibility.** You remain solely responsible for your health and safety. Always obtain advice from a qualified physician or other licensed healthcare provider with any questions you may have regarding a medical condition or before engaging in exposure to extreme temperatures, strenuous physical activity, or other potentially dangerous situations.

4. **No Reliance.** You agree not to rely on the Application for life-critical or safety-critical decisions, or as motivation to test or exceed your physical limits. Use of the Application for occupational health and safety compliance, clinical care, or emergency planning is expressly prohibited.

5. **Assumption of Risk.** You assume all risks, known and unknown, arising from the use or misuse of the Application. The developer(s) make no warranties or representations, express or implied, regarding accuracy, completeness, or fitness for a particular purpose.

6. **Limitation of Liability.** To the maximum extent permitted by applicable law, in no event shall the developer(s), contributors, or hosting providers be liable for any direct, indirect, incidental, special, consequential, punitive, or exemplary damages, including but not limited to personal injury, wrongful death, lost profits, or business interruption, arising out of or in connection with the Application or its outputs, even if advised of the possibility of such damages.

7. **Indemnification.** You agree to indemnify, defend, and hold harmless the developer(s), contributors, and affiliates from and against any and all claims, liabilities, damages, losses, or expenses (including reasonable attorneys' fees) arising out of or in any way connected with your access to or use of the Application.

8. **Jurisdiction.** These terms are governed by and construed in accordance with the laws of the jurisdiction in which the developer(s) is/are located, without regard to its conflict of law provisions. Any dispute arising from or relating to these terms or the Application shall be brought exclusively in the competent courts of that jurisdiction.

If you do not agree to every term above, you must not use or access the Application.

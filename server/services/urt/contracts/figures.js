// Structured figures a passage can carry; the client renders them (PLAN.md §6.2, INTEGRATION.md).
import { z } from 'zod';

export const FIGURE_KINDS = ['table', 'line_chart', 'bar_chart', 'scatter_plot'];
export const CHART_KINDS = ['line_chart', 'bar_chart', 'scatter_plot'];

const figureId = z.string().regex(/^fig\d+$/, 'figure ids are fig1, fig2, …');
const cell = z.union([z.string(), z.number()]);

export const TableFigure = z.object({
  id: figureId,
  kind: z.literal('table'),
  title: z.string().min(1),
  caption: z.string().optional(),
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(z.array(cell)).min(1),
});

export const Axis = z.object({
  label: z.string().min(1),
  unit: z.string().optional(),
  // Bar charts over named categories put the category names here; point x values are then 0-based indexes.
  categories: z.array(z.string().min(1)).optional(),
});

export const Series = z.object({
  name: z.string().min(1),
  points: z.array(z.tuple([z.number(), z.number()])).min(1),
});

export const ChartFigure = z.object({
  id: figureId,
  kind: z.enum(CHART_KINDS),
  title: z.string().min(1),
  caption: z.string().optional(),
  xAxis: Axis,
  yAxis: Axis,
  series: z.array(Series).min(1),
});

export const Figure = z.union([TableFigure, ChartFigure]);

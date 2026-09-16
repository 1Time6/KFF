'use client';
import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

/**
 * A labelled form field.
 *
 * The label's `for` attribute must point at the control itself, so the id goes to the control and
 * to nothing else. Two shapes reach this component, and both have to work:
 *
 * - the control as a direct child, optionally with a `hint` prop beside it;
 * - the control inside a single wrapping element, which is how a field carries something other
 *   than text next to its input, such as a short list under a select.
 *
 * An earlier version cloned the id onto the single direct child, so wrapping a select in a span in
 * order to attach a hint silently moved the id onto the span: the label then referenced an id that
 * did not exist, screen readers lost the association, and label-based lookups stopped matching.
 * Passing the id down through one wrapper keeps that association whether or not the wrapper is
 * there. A wrapper that holds no control is left untouched rather than given a stray id.
 *
 * This is the single definition for the whole workbench; the per-file copies that had drifted apart
 * are imported from here.
 */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  const id = useId();
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {Children.map(children, child => withControlId(child, id))}
    {hint !== undefined && hint !== null && <span className="field-hint">{hint}</span>}
  </div>;
}
/** Give the id to the control, descending through one wrapper element when that is where it sits. */
function withControlId(child: ReactNode, id: string): ReactNode {
  if (isControl(child)) return cloneElement(child as ReactElement<{ id?: string }>, { id });
  if (!isValidElement<{ children?: ReactNode }>(child)) return child;
  const nested = Children.toArray(child.props.children);
  if (!nested.some(isControl)) return child;
  return cloneElement(child, undefined, Children.map(nested, grandchild => withControlId(grandchild, id)));
}
function isControl(value: ReactNode): boolean {
  return isValidElement(value) && ['input', 'select', 'textarea'].includes(String(value.type));
}

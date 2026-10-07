"use client"

import { useState } from "react"
import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DeleteOutlined } from "@/components/ui/AppIcon"

interface Props {
  open: boolean
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  global?: boolean
  onConfirm: () => Promise<boolean> | boolean
  onCancel: () => void
}

export default function DestructiveConfirmModal({
  open,
  title,
  description,
  confirmText,
  cancelText,
  global = false,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)

  const handleConfirm = async () => {
    if (loading) return
    setLoading(true)
    try {
      if (await onConfirm()) {
        onCancel()
      }
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    setLoading(false)
    onCancel()
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) handleCancel()
      }}
    >
      <AlertDialogContent global={global} size="sm">
        <AlertDialogHeader>
          <AlertDialogMedia
            aria-hidden="true"
            className="bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive"
          >
            <DeleteOutlined />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>
            {cancelText ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={loading}
            onClick={(event) => {
              event.preventDefault()
              void handleConfirm()
            }}
          >
            {confirmText ?? t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
